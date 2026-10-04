/**
 * src/bathymetry/index.js
 *
 * High-resolution bathymetry from the SHOM digital elevation models (MNT),
 * served to the displays as elevation tiles that work without internet.
 *
 * When the boat has internet (marina, 4G), the coastal models around its
 * position are downloaded from data.shom.fr (7z archives), converted to a
 * compact grid on disk and kept: at sea, every display gets the tiles from
 * the boat's server. Archives can also be dropped by hand in
 * <dataDir>/bathymetry/import (a 7z from data.shom.fr or the .asc inside).
 *
 * Extracting the 7z archives needs the `7z` command (apt install p7zip-full);
 * without it, extract the .asc on a computer and drop it in the import folder.
 *
 * Routes (under /signalk/v2/api/plugins/ocearo-core), see registerRoutes:
 *   GET    /bathymetry/tiles/:z/:x/:y.png  Terrarium tile, 404 where not covered
 *   GET    /bathymetry/status              regions, jobs, catalogue near the boat
 *   POST   /bathymetry/download            { id? , lat?, lon?, radiusNm? }
 *   POST   /bathymetry/import              convert what is in the import folder
 *   DELETE /bathymetry/regions/:id
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const { SHOM_DATASETS, datasetsAround, bboxAround } = require('./catalog');
const { convertAsc, loadRegion, bounds } = require('./grid');
const { renderTile } = require('./tiles');

const NM = 1852;
const MIN_ZOOM = 8;
const MAX_ZOOM = 16;
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
const SEVEN_ZIP = ['7z', '7za', '7zr'];

class BathymetryManager {
    /**
     * @param {object} app      Signal K app object
     * @param {object} options  plugin options; uses options.bathymetry
     */
    constructor(app, options = {}) {
        this.app = app;
        const cfg = options.bathymetry || {};
        this.enabled = cfg.enabled !== false;
        this.autoDownload = cfg.autoDownload !== false;
        this.radiusNm = Number(cfg.radiusNm) > 0 ? Number(cfg.radiusNm) : 30;
        this.dir = path.join(app.getDataDirPath(), 'bathymetry');
        this.regionsDir = path.join(this.dir, 'regions');
        this.tilesDir = path.join(this.dir, 'tiles');
        this.importDir = path.join(this.dir, 'import');
        this.workDir = path.join(this.dir, 'work');

        /** Region headers by id; `data` loaded on first use */
        this.regions = new Map();
        /** Jobs by dataset id: { id, name, state, received, total, error, at } */
        this.jobs = new Map();
        this.queue = Promise.resolve();
        this.sevenZip = undefined;
        this.timer = null;
        this.empty = new Set();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    start() {
        if (!this.enabled) return;
        for (const d of [this.regionsDir, this.tilesDir, this.importDir, this.workDir]) {
            fs.mkdirSync(d, { recursive: true });
        }
        this._loadHeaders();
        if (this.autoDownload) {
            // First look once the position is known, then every 15 min
            this.timer = setInterval(() => this._autoCheck(), CHECK_INTERVAL_MS);
            setTimeout(() => this._autoCheck(), 30 * 1000).unref?.();
        }
        this.app.debug(`Bathymetry: ${this.regions.size} SHOM region(s) in ${this.regionsDir}`);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Regions
    // ─────────────────────────────────────────────────────────────────────────

    _loadHeaders() {
        this.regions.clear();
        for (const f of fs.readdirSync(this.regionsDir)) {
            if (!f.endsWith('.json')) continue;
            try {
                const h = JSON.parse(fs.readFileSync(path.join(this.regionsDir, f), 'utf8'));
                if (fs.existsSync(path.join(this.regionsDir, `${h.id}.f32`))) {
                    this.regions.set(h.id, { ...h, ...bounds(h), data: null });
                }
            } catch (error) {
                this.app.error(`Bathymetry: unreadable region ${f}: ${error.message}`);
            }
        }
    }

    /** Regions with their grids in memory (loaded lazily, kept) */
    _loadedRegions() {
        const out = [];
        for (const [id, r] of this.regions) {
            if (!r.data) {
                try {
                    Object.assign(r, loadRegion(path.join(this.regionsDir, id)));
                } catch (error) {
                    this.app.error(`Bathymetry: cannot load region ${id}: ${error.message}`);
                    continue;
                }
            }
            out.push(r);
        }
        return out;
    }

    /** Tiles are rendered from the regions: drop them when the regions change */
    _clearTiles() {
        fs.rmSync(this.tilesDir, { recursive: true, force: true });
        fs.mkdirSync(this.tilesDir, { recursive: true });
        this.empty.clear();
    }

    removeRegion(id) {
        if (!this.regions.has(id)) return false;
        for (const ext of ['.json', '.f32']) {
            fs.rmSync(path.join(this.regionsDir, `${id}${ext}`), { force: true });
        }
        this.regions.delete(id);
        this._clearTiles();
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Tiles
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * PNG tile, from the disk cache or rendered; null where no SHOM model
     * covers it (the client then uses its global source).
     */
    tile(z, x, y) {
        if (z < MIN_ZOOM || z > MAX_ZOOM || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return null;
        if (!this.regions.size) return null;
        const key = `${z}/${x}/${y}`;
        if (this.empty.has(key)) return null;
        const file = path.join(this.tilesDir, String(z), String(x), `${y}.png`);
        if (fs.existsSync(file)) return fs.readFileSync(file);
        const png = renderTile(this._loadedRegions(), z, x, y);
        if (!png) {
            this.empty.add(key);
            return null;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, png);
        return png;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Download and import
    // ─────────────────────────────────────────────────────────────────────────

    _position() {
        const p = this.app.getSelfPath?.('navigation.position');
        const v = p?.value ?? p;
        return Number.isFinite(v?.latitude) && Number.isFinite(v?.longitude) ? v : null;
    }

    /** Coastal models around the boat that are not on board yet */
    async _autoCheck() {
        const pos = this._position();
        if (!pos) return;
        const wanted = datasetsAround(pos.latitude, pos.longitude, this.radiusNm * NM)
            .filter(d => d.kind === 'coastal' && !this.regions.has(d.id))
            .filter(d => {
                const job = this.jobs.get(d.id);
                if (!job) return true;
                return job.state === 'error' && Date.now() - job.at > RETRY_AFTER_MS;
            });
        if (!wanted.length || !(await this._online())) return;
        for (const d of wanted) this.download(d.id);
    }

    _online() {
        return new Promise((resolve) => {
            const req = https.request('https://services.data.shom.fr/', { method: 'HEAD', timeout: 8000 }, (res) => {
                res.resume();
                resolve(true);
            });
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.on('error', () => resolve(false));
            req.end();
        });
    }

    /**
     * Queues the download of a dataset. Façade models are cropped to
     * `radiusNm` around the position (the boat's by default).
     * @returns {object} the job
     */
    download(id, { lat, lon, radiusNm } = {}) {
        const dataset = SHOM_DATASETS.find(d => d.id === id);
        if (!dataset) throw new Error(`Unknown SHOM dataset: ${id}`);
        const running = this.jobs.get(id);
        if (running && !['done', 'error'].includes(running.state)) return running;

        let crop = null;
        if (dataset.kind === 'facade') {
            const pos = Number.isFinite(lat) && Number.isFinite(lon) ? { latitude: lat, longitude: lon } : this._position();
            if (!pos) throw new Error('A position is needed to crop a façade model');
            crop = bboxAround(pos.latitude, pos.longitude, (radiusNm || this.radiusNm * 2) * NM);
        }
        const job = { id, name: dataset.name, state: 'queued', received: 0, total: 0, error: null, at: Date.now() };
        this.jobs.set(id, job);
        this.queue = this.queue.then(() => this._run(job, dataset, crop));
        return job;
    }

    async _run(job, dataset, crop) {
        const archive = path.join(this.workDir, `${dataset.id}.7z`);
        const out = path.join(this.workDir, dataset.id);
        try {
            job.state = 'downloading';
            await this._fetch(dataset.url, archive, (received, total) => {
                job.received = received;
                job.total = total;
            });
            job.state = 'extracting';
            const asc = await this._extract(archive, out);
            job.state = 'converting';
            await convertAsc(asc, path.join(this.regionsDir, dataset.id), {
                id: dataset.id,
                name: dataset.name,
                source: 'SHOM',
                license: 'Licence Ouverte Etalab 2.0',
                datum: 'PBMA',
                resolutionM: dataset.resolutionM,
            }, crop);
            this._loadHeaders();
            this._clearTiles();
            job.state = 'done';
            this.app.debug(`Bathymetry: ${dataset.name} installed`);
        } catch (error) {
            job.state = 'error';
            job.error = error.message;
            this.app.error(`Bathymetry: ${dataset.name}: ${error.message}`);
        } finally {
            job.at = Date.now();
            fs.rmSync(archive, { force: true });
            fs.rmSync(`${archive}.part`, { force: true });
            fs.rmSync(out, { recursive: true, force: true });
        }
    }

    /** HTTPS download to a file, following redirects */
    _fetch(url, file, onProgress, redirects = 5) {
        return new Promise((resolve, reject) => {
            https.get(url, { timeout: 60000 }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
                    res.resume();
                    resolve(this._fetch(new URL(res.headers.location, url).href, file, onProgress, redirects - 1));
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                const total = Number(res.headers['content-length']) || 0;
                let received = 0;
                const part = `${file}.part`;
                const stream = fs.createWriteStream(part);
                res.on('data', (c) => { received += c.length; onProgress(received, total); });
                res.pipe(stream);
                stream.on('finish', () => {
                    if (total && received !== total) {
                        reject(new Error('Download interrupted'));
                        return;
                    }
                    fs.renameSync(part, file);
                    resolve();
                });
                res.on('error', reject);
                stream.on('error', reject);
            }).on('timeout', function onTimeout() { this.destroy(new Error('Timeout')); })
                .on('error', reject);
        });
    }

    async _findSevenZip() {
        if (this.sevenZip !== undefined) return this.sevenZip;
        for (const cmd of SEVEN_ZIP) {
            const ok = await new Promise((resolve) => {
                const p = spawn(cmd, ['i'], { stdio: 'ignore' });
                p.on('error', () => resolve(false));
                p.on('close', (code) => resolve(code === 0));
            });
            if (ok) {
                this.sevenZip = cmd;
                return cmd;
            }
        }
        this.sevenZip = null;
        return null;
    }

    /** Extracts the ESRI ASCII grid of a SHOM archive; returns its path */
    async _extract(archive, outDir) {
        const cmd = await this._findSevenZip();
        if (!cmd) throw new Error('7z is not installed (apt install p7zip-full)');
        fs.mkdirSync(outDir, { recursive: true });
        await new Promise((resolve, reject) => {
            const p = spawn(cmd, ['e', '-y', `-o${outDir}`, archive, '*.asc', '-r'], { stdio: 'ignore' });
            p.on('error', reject);
            p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`7z exited with ${code}`))));
        });
        const asc = fs.readdirSync(outDir).find(f => f.toLowerCase().endsWith('.asc'));
        if (!asc) throw new Error('No ASCII grid (.asc) in the archive');
        return path.join(outDir, asc);
    }

    /**
     * Converts the archives (.7z) and grids (.asc) dropped in the import
     * folder. Files are removed once converted.
     * @returns {Promise<string[]>} ids of the regions created
     */
    async importFolder() {
        const created = [];
        for (const f of fs.readdirSync(this.importDir)) {
            const ext = path.extname(f).toLowerCase();
            if (ext !== '.7z' && ext !== '.asc') continue;
            const id = path.basename(f, path.extname(f)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            const src = path.join(this.importDir, f);
            const out = path.join(this.workDir, id);
            try {
                const asc = ext === '.7z' ? await this._extract(src, out) : src;
                const known = SHOM_DATASETS.find(d => f.toUpperCase().includes(d.url.split('/').pop().replace('.7z', '')));
                await convertAsc(asc, path.join(this.regionsDir, known?.id || id), {
                    id: known?.id || id,
                    name: known?.name || f,
                    source: 'SHOM',
                    license: 'Licence Ouverte Etalab 2.0',
                    datum: /_NM[_.]/i.test(f) ? 'NM' : 'PBMA',
                    resolutionM: known?.resolutionM ?? null,
                });
                fs.rmSync(src, { force: true });
                created.push(known?.id || id);
            } catch (error) {
                this.app.error(`Bathymetry: cannot import ${f}: ${error.message}`);
            } finally {
                fs.rmSync(out, { recursive: true, force: true });
            }
        }
        if (created.length) {
            this._loadHeaders();
            this._clearTiles();
        }
        return created;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Status and routes
    // ─────────────────────────────────────────────────────────────────────────

    status() {
        const pos = this._position();
        return {
            enabled: this.enabled,
            autoDownload: this.autoDownload,
            radiusNm: this.radiusNm,
            sevenZip: this.sevenZip,
            minZoom: MIN_ZOOM,
            maxZoom: MAX_ZOOM,
            encoding: 'terrarium',
            regions: [...this.regions.values()].map(({ data, ...h }) => h),
            jobs: [...this.jobs.values()],
            available: pos
                ? datasetsAround(pos.latitude, pos.longitude, this.radiusNm * NM).map(d => ({
                    id: d.id, name: d.name, kind: d.kind, resolutionM: d.resolutionM, installed: this.regions.has(d.id),
                }))
                : [],
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes. Signal K registers them once, possibly before plugin.start() has
// created the manager and never again after a restart from the admin UI, so
// they resolve the current manager on every request.
// ─────────────────────────────────────────────────────────────────────────────

const ready = (get) => (req, res, next) => {
    const m = get();
    if (!m || !m.enabled) return res.status(503).json({ error: 'Bathymetry not enabled' });
    req.bathymetry = m;
    return next();
};

/**
 * Tile route, registered before the plugin's rate limiter: a 3D view asks
 * for a dozen tiles at a time. The tiles are open data.
 */
const registerTileRoute = (router, get) => {
    router.get('/bathymetry/tiles/:z/:x/:y', ready(get), (req, res) => {
        const m = req.bathymetry;
        const z = Number(req.params.z);
        const x = Number(req.params.x);
        const y = Number(String(req.params.y).replace(/\.png$/, ''));
        res.set('Access-Control-Allow-Origin', '*');
        if (![z, x, y].every(Number.isInteger)) return res.status(400).end();
        let png;
        try {
            png = m.tile(z, x, y);
        } catch (error) {
            m.app.error(`Bathymetry tile ${z}/${x}/${y}: ${error.message}`);
            return res.status(500).end();
        }
        if (!png) return res.status(404).end();
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'public, max-age=86400');
        res.set('X-Vertical-Datum', 'PBMA');
        return res.send(png);
    });
};

const registerRoutes = (router, get) => {
    router.get('/bathymetry/status', ready(get), async (req, res) => {
        await req.bathymetry._findSevenZip();
        res.json(req.bathymetry.status());
    });

    router.post('/bathymetry/download', ready(get), (req, res) => {
        const m = req.bathymetry;
        const { id, lat, lon, radiusNm } = req.body || {};
        try {
            let ids = id ? [id] : [];
            if (!id) {
                const pos = Number.isFinite(lat) && Number.isFinite(lon) ? { latitude: lat, longitude: lon } : m._position();
                if (!pos) return res.status(400).json({ error: 'No position' });
                ids = datasetsAround(pos.latitude, pos.longitude, (radiusNm || m.radiusNm) * NM)
                    .filter(d => d.kind === 'coastal' && !m.regions.has(d.id))
                    .map(d => d.id);
            }
            return res.json({ jobs: ids.map(i => m.download(i, { lat, lon, radiusNm })) });
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }
    });

    router.post('/bathymetry/import', ready(get), async (req, res) => {
        try {
            res.json({ created: await req.bathymetry.importFolder() });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.delete('/bathymetry/regions/:id', ready(get), (req, res) => {
        res.json({ removed: req.bathymetry.removeRegion(req.params.id) });
    });
};

module.exports = BathymetryManager;
module.exports.registerTileRoute = registerTileRoute;
module.exports.registerRoutes = registerRoutes;
