const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const MemoryManager = require('../src/memory');

const tmpRoot = () => fs.mkdtemp(path.join(os.tmpdir(), 'ocearo-memory-'));

// A Signal K app with ~/.signalk as config dir and the plugin's data dir in it
const appFor = (root, errors = []) => ({
    debug: () => {},
    error: (msg) => errors.push(msg),
    config: { configPath: path.join(root, '.signalk') },
    getDataDirPath: () => path.join(root, '.signalk', 'plugin-config-data', 'ocearo-core')
});

test('memory lives in the plugin data directory', async () => {
    const root = await tmpRoot();
    const memory = new MemoryManager(appFor(root), {});
    assert.strictEqual(memory.dataDir, path.join(root, '.signalk', 'plugin-config-data', 'ocearo-core', 'memory'));
});

test('files left in the old location are moved on start', async () => {
    const root = await tmpRoot();
    const legacy = path.join(root, 'ocearo-core');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, 'alerts.json'), JSON.stringify([{ key: 'old' }]));
    const memory = new MemoryManager(appFor(root), {});
    await memory.start();
    await memory.stop();
    assert.deepStrictEqual(memory.alertHistory, [{ key: 'old' }]);
    await assert.rejects(fs.access(legacy), 'the emptied old directory is removed');
});

test('overlapping saves do not fail', async () => {
    const root = await tmpRoot();
    const errors = [];
    const memory = new MemoryManager(appFor(root, errors), {});
    await memory.ensureDataDirectory();
    memory.alertHistory = Array.from({ length: 500 }, (_, i) => ({ key: `a${i}`, message: 'x'.repeat(200) }));
    await Promise.all([memory.persistData(), memory.persistData(), memory.persistData()]);
    assert.deepStrictEqual(errors, []);
    const saved = JSON.parse(await fs.readFile(path.join(memory.dataDir, 'alerts.json'), 'utf8'));
    assert.strictEqual(saved.length, 500);
    const leftovers = (await fs.readdir(memory.dataDir)).filter((f) => f.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, []);
});
