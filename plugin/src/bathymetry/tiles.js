/**
 * src/bathymetry/tiles.js
 *
 * Web Mercator elevation tiles in the Terrarium encoding used by the
 * Océaro 3D view (and by Mapzen / AWS open terrain tiles):
 *   h = R·256 + G + B/256 − 32768   (metres)
 * The alpha channel says which pixels the SHOM models cover (255) and which
 * they do not (0), so the client can fall back to a global source there.
 */

const { encodePng } = require('./png');
const { sampleRegion } = require('./grid');

const SIZE = 256;

const tileBounds = (z, x, y) => {
    const n = 2 ** z;
    const lon = (px) => px / n * 360 - 180;
    const lat = (py) => Math.atan(Math.sinh(Math.PI * (1 - 2 * py / n))) * 180 / Math.PI;
    return { west: lon(x), east: lon(x + 1), north: lat(y), south: lat(y + 1) };
};

/** Regions overlapping a tile, finest first */
const regionsForTile = (regions, z, x, y) => {
    const b = tileBounds(z, x, y);
    return regions
        .filter(r => r.west <= b.east && r.east >= b.west && r.south <= b.north && r.north >= b.south)
        .sort((p, q) => p.cellsize - q.cellsize);
};

/**
 * Renders one tile, or null when no region touches it.
 * @returns {Buffer|null} PNG
 */
const renderTile = (regions, z, x, y) => {
    const hits = regionsForTile(regions, z, x, y);
    if (!hits.length) return null;
    const n = 2 ** z;
    const rgba = new Uint8Array(SIZE * SIZE * 4);
    let covered = 0;
    for (let py = 0; py < SIZE; py++) {
        const my = y + (py + 0.5) / SIZE;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * my / n))) * 180 / Math.PI;
        for (let px = 0; px < SIZE; px++) {
            const lon = (x + (px + 0.5) / SIZE) / n * 360 - 180;
            let h = NaN;
            for (const r of hits) {
                h = sampleRegion(r, lat, lon);
                if (!Number.isNaN(h)) break;
            }
            const o = (py * SIZE + px) * 4;
            if (Number.isNaN(h)) continue; // transparent: not covered
            const v = Math.max(0, Math.min(65535.996, h + 32768));
            rgba[o] = Math.floor(v / 256);
            rgba[o + 1] = Math.floor(v) % 256;
            rgba[o + 2] = Math.floor((v - Math.floor(v)) * 256);
            rgba[o + 3] = 255;
            covered++;
        }
    }
    return covered ? encodePng(rgba, SIZE, SIZE) : null;
};

module.exports = { renderTile, tileBounds, regionsForTile };
