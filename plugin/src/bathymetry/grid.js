/**
 * src/bathymetry/grid.js
 *
 * Elevation grids ("regions") converted from the SHOM ESRI ASCII grids and
 * stored as raw Float32 (little-endian, north row first) with a JSON header:
 *
 *   <dir>/<id>.json  { id, name, source, datum, ncols, nrows, cellsize,
 *                      west, north (cell centres, degrees), resolutionM }
 *   <dir>/<id>.f32
 *
 * The ASCII grid is read as a stream and can be cropped to a bounding box
 * while reading, so a 100 m façade model (≈ 1 GB of text) never sits in
 * memory whole.
 */

const fs = require('fs');
const readline = require('readline');

const NODATA = -9999;

/**
 * Converts an ESRI ASCII grid to a region, optionally cropped.
 *
 * @param {string} ascPath
 * @param {string} outBase  path without extension
 * @param {object} meta     id, name, source, datum, resolutionM
 * @param {[number, number, number, number]} [crop]  west, south, east, north
 * @returns {Promise<object>} the region header
 */
const convertAsc = async (ascPath, outBase, meta, crop) => {
    const input = fs.createReadStream(ascPath, { encoding: 'latin1', highWaterMark: 1 << 20 });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    const header = {};
    let row = 0;
    let out = null;
    let win = null;
    let tmp = null;

    const open = () => {
        const { ncols, nrows, cellsize } = header;
        // Cell centres: ESRI grids give either the corner or the centre
        const x0 = header.xllcenter ?? (header.xllcorner + cellsize / 2);
        const y0 = header.yllcenter ?? (header.yllcorner + cellsize / 2);
        const yTop = y0 + (nrows - 1) * cellsize;
        let c0 = 0; let c1 = ncols - 1; let r0 = 0; let r1 = nrows - 1;
        if (crop) {
            c0 = Math.max(0, Math.floor((crop[0] - x0) / cellsize));
            c1 = Math.min(ncols - 1, Math.ceil((crop[2] - x0) / cellsize));
            r0 = Math.max(0, Math.floor((yTop - crop[3]) / cellsize));
            r1 = Math.min(nrows - 1, Math.ceil((yTop - crop[1]) / cellsize));
            if (c1 < c0 || r1 < r0) throw new Error('The model does not cover this area');
        }
        win = { c0, c1, r0, r1, nodata: header.nodata_value ?? NODATA };
        tmp = `${outBase}.f32.part`;
        out = fs.openSync(tmp, 'w');
        return {
            ncols: c1 - c0 + 1,
            nrows: r1 - r0 + 1,
            cellsize,
            west: x0 + c0 * cellsize,
            north: yTop - r0 * cellsize,
        };
    };

    let region = null;
    try {
        for await (const line of rl) {
            if (!region) {
                const m = /^\s*([A-Za-z_]+)\s+(-?[\d.eE+-]+)\s*$/.exec(line);
                if (m) {
                    header[m[1].toLowerCase()] = Number(m[2]);
                    continue;
                }
                if (!(header.ncols && header.nrows && header.cellsize)) throw new Error('Not an ESRI ASCII grid');
                region = open();
            }
            if (row >= win.r0 && row <= win.r1 && line.trim()) {
                const values = line.trim().split(/\s+/);
                const buf = Buffer.alloc((win.c1 - win.c0 + 1) * 4);
                for (let c = win.c0, k = 0; c <= win.c1; c++, k += 4) {
                    const v = Number(values[c]);
                    buf.writeFloatLE(Number.isFinite(v) && v !== win.nodata ? v : NaN, k);
                }
                fs.writeSync(out, buf);
            }
            if (line.trim()) row++;
            if (row > win.r1) break;
        }
    } finally {
        rl.close();
        input.destroy();
        if (out !== null) fs.closeSync(out);
    }
    if (!region) throw new Error('Empty grid');
    fs.renameSync(tmp, `${outBase}.f32`);
    const full = { ...meta, ...region, createdAt: new Date().toISOString() };
    fs.writeFileSync(`${outBase}.json`, JSON.stringify(full, null, 2));
    return full;
};

/** Loads a region's grid into memory */
const loadRegion = (base) => {
    const header = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
    const bytes = fs.readFileSync(`${base}.f32`);
    // Copy into an aligned buffer for the Float32Array view
    const data = new Float32Array(bytes.length / 4);
    Buffer.from(data.buffer).set(bytes);
    return { ...header, data, ...bounds(header) };
};

/** West, south, east, north of the area covered (cell centres) */
const bounds = (h) => ({
    east: h.west + (h.ncols - 1) * h.cellsize,
    south: h.north - (h.nrows - 1) * h.cellsize,
});

/**
 * Elevation (m) at a position, bilinear between the four cells around it;
 * NaN outside the grid or on missing cells.
 */
const sampleRegion = (r, lat, lon) => {
    const fx = (lon - r.west) / r.cellsize;
    const fy = (r.north - lat) / r.cellsize;
    if (fx < 0 || fy < 0 || fx > r.ncols - 1 || fy > r.nrows - 1) return NaN;
    const i = Math.min(r.ncols - 2, Math.floor(fx));
    const j = Math.min(r.nrows - 2, Math.floor(fy));
    const a = fx - i;
    const b = fy - j;
    const k = j * r.ncols + i;
    const d = r.data;
    const v00 = d[k]; const v10 = d[k + 1]; const v01 = d[k + r.ncols]; const v11 = d[k + r.ncols + 1];
    if (Number.isNaN(v00) || Number.isNaN(v10) || Number.isNaN(v01) || Number.isNaN(v11)) {
        // At the edge of the survey: nearest cell if it has a value
        return d[Math.round(fy) * r.ncols + Math.round(fx)];
    }
    return (v00 * (1 - a) + v10 * a) * (1 - b) + (v01 * (1 - a) + v11 * a) * b;
};

module.exports = { convertAsc, loadRegion, sampleRegion, bounds };
