const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { convertAsc, loadRegion, sampleRegion } = require('../src/bathymetry/grid');
const { renderTile } = require('../src/bathymetry/tiles');
const { datasetsAround } = require('../src/bathymetry/catalog');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocearo-bathy-'));

/** 5×4 grid, 0.01° cells, centres from -1.20 E / 46.10 N; depth grows to the west */
const writeAsc = () => {
    const rows = [];
    for (let r = 0; r < 4; r++) rows.push([0, 1, 2, 3, 4].map(c => (c === 4 && r === 0 ? -9999 : -10 + c * 2)).join(' '));
    const file = path.join(tmp, 'test.asc');
    fs.writeFileSync(file, `ncols 5\nnrows 4\nxllcenter -1.20\nyllcenter 46.10\ncellsize 0.01\nnodata_value -9999\n${rows.join('\n')}\n`);
    return file;
};

/** Decodes an RGBA PNG written by png.js (filter 0) */
const decode = (png) => {
    let i = 8;
    const idat = [];
    while (i < png.length) {
        const n = png.readUInt32BE(i);
        const type = png.toString('ascii', i + 4, i + 8);
        if (type === 'IDAT') idat.push(png.subarray(i + 8, i + 8 + n));
        i += 12 + n;
    }
    return zlib.inflateSync(Buffer.concat(idat));
};

test('converts an ESRI ASCII grid and samples it bilinearly', async () => {
    const header = await convertAsc(writeAsc(), path.join(tmp, 'r'), { id: 'r', datum: 'PBMA' });
    assert.strictEqual(header.ncols, 5);
    assert.strictEqual(header.nrows, 4);
    assert.ok(Math.abs(header.north - 46.13) < 1e-9);
    const region = loadRegion(path.join(tmp, 'r'));
    assert.ok(Math.abs(sampleRegion(region, 46.11, -1.19) - -8) < 1e-4);
    assert.ok(Math.abs(sampleRegion(region, 46.11, -1.185) - -7) < 1e-4);
    assert.ok(Number.isNaN(sampleRegion(region, 46.11, -1.0)));
    // Missing cell (top right) is NaN
    assert.ok(Number.isNaN(region.data[4]));
});

test('crops while converting', async () => {
    const header = await convertAsc(writeAsc(), path.join(tmp, 'c'), { id: 'c' }, [-1.185, 46.105, -1.175, 46.115]);
    assert.ok(header.ncols < 5 && header.nrows < 4);
    const region = loadRegion(path.join(tmp, 'c'));
    assert.ok(Math.abs(sampleRegion(region, 46.11, -1.18) - -6) < 1e-4);
});

test('renders Terrarium tiles with coverage in the alpha channel', () => {
    const region = loadRegion(path.join(tmp, 'r'));
    const z = 12;
    const n = 2 ** z;
    const x = Math.floor((-1.18 + 180) / 360 * n);
    const r = 46.115 * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
    const raw = decode(renderTile([region], z, x, y));
    let covered = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let row = 0; row < 256; row++) {
        for (let col = 0; col < 256; col++) {
            const o = row * (256 * 4 + 1) + 1 + col * 4;
            if (!raw[o + 3]) continue;
            covered++;
            const h = raw[o] * 256 + raw[o + 1] + raw[o + 2] / 256 - 32768;
            min = Math.min(min, h);
            max = Math.max(max, h);
        }
    }
    assert.ok(covered > 0 && covered < 256 * 256);
    assert.ok(min >= -10.01 && max <= -1.99);
    assert.strictEqual(renderTile([region], z, 0, 0), null);
});

test('finds the SHOM models around La Rochelle, finest first', () => {
    const ids = datasetsAround(46.15, -1.16, 10 * 1852).map(d => d.id);
    assert.ok(ids.includes('pertuis-charentais'));
    assert.ok(ids.includes('facade-atlantique'));
    assert.ok(ids.indexOf('pertuis-charentais') < ids.indexOf('facade-atlantique'));
});
