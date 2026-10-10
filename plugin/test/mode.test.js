const { test } = require('node:test');
const assert = require('node:assert');
const ModeManager = require('../src/brain/mode-manager');
const AlertAnalyzer = require('../src/analyses/alert');

const KN = 1 / 1.943844; // m/s per knot
const MARINA = { latitude: 46.14327, longitude: -1.16451 };
// ~ metres north of the marina position
const north = (m) => ({ latitude: MARINA.latitude + m / 111320, longitude: MARINA.longitude });

test('startup: moored, or anchored when the anchor was down', () => {
    const mm = new ModeManager();
    assert.strictEqual(mm.startupMode(false), 'moored');
    assert.strictEqual(mm.startupMode(true), 'anchored');
});

test('moored: GPS jitter and a gust on the pontoon do not count as a departure', () => {
    const mm = new ModeManager();
    mm.setMode('moored', 'startup');
    let t = 0;
    for (let i = 0; i < 60; i++, t += 5000) {
        // ±15 m of jitter, SOG spikes of 2 kn lasting a few seconds
        const sogMs = i % 7 === 0 ? 2 * KN : 0.2 * KN;
        assert.strictEqual(mm.observe({ sogMs, position: north((i % 3) * 15), engineRunning: false, now: t }), null);
    }
});

test('moored: sustained speed means under way, under engine when it runs', () => {
    const mm = new ModeManager();
    mm.setMode('moored', 'user');
    let result = null;
    for (let t = 0; t <= 50000 && !result; t += 5000) {
        result = mm.observe({ sogMs: 3 * KN, position: null, engineRunning: true, now: t });
    }
    assert.strictEqual(result, 'motoring');
});

test('moored: leaving the berth slowly still switches, by distance', () => {
    const mm = new ModeManager();
    mm.setMode('moored', 'startup');
    assert.strictEqual(mm.observe({ sogMs: 1 * KN, position: MARINA, engineRunning: false, now: 0 }), null);
    assert.strictEqual(mm.observe({ sogMs: 1 * KN, position: north(60), engineRunning: false, now: 5000 }), null);
    assert.strictEqual(mm.observe({ sogMs: 1 * KN, position: north(130), engineRunning: false, now: 10000 }), 'sailing');
});

test('anchored never ends on its own, even when dragging fast', () => {
    const mm = new ModeManager();
    mm.setMode('anchored', 'user');
    for (let t = 0; t < 120000; t += 5000) {
        assert.strictEqual(mm.observe({ sogMs: 4 * KN, position: north(t / 100), engineRunning: false, now: t }), null);
    }
});

test('under way: the mode manager does not switch back to moored', () => {
    const mm = new ModeManager();
    mm.setMode('sailing', 'auto');
    assert.strictEqual(mm.observe({ sogMs: 0, position: MARINA, engineRunning: false, now: 0 }), null);
});

test('alert policy per mode', () => {
    const mm = new ModeManager();
    assert.deepStrictEqual(mm.alertPolicy('moored'), { collision: false, depth: 'off', routine: false });
    assert.deepStrictEqual(mm.alertPolicy('anchored'), { collision: false, depth: 'once', routine: false });
    for (const mode of ['sailing', 'motoring', 'racing']) {
        assert.deepStrictEqual(mm.alertPolicy(mode), { collision: true, depth: 'continuous', routine: true });
    }
});

test('lowest depth ahead: falling tide lowers the water by the coming range', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    const tide = {
        current: { height: 5.0 },
        next: { low: { time: new Date('2026-10-10T17:00:00Z'), height: 1.0 }, high: { time: new Date('2026-10-10T23:00:00Z'), height: 5.5 } }
    };
    const ahead = ModeManager.lowestDepthAhead(6.0, tide, now);
    assert.strictEqual(ahead.depth, 2.0);
    assert.strictEqual(ahead.time.toISOString(), '2026-10-10T17:00:00.000Z');
});

test('lowest depth ahead: nothing while the tide is rising', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    const tide = {
        current: { height: 2.0 },
        next: { high: { time: new Date('2026-10-10T15:00:00Z'), height: 5.5 }, low: { time: new Date('2026-10-10T21:00:00Z'), height: 1.0 } }
    };
    assert.strictEqual(ModeManager.lowestDepthAhead(6.0, tide, now), null);
    assert.strictEqual(ModeManager.lowestDepthAhead(6.0, null, now), null);
});

test('alerts: instrument depth and CPA alarms are silent alongside, spoken under way', () => {
    const analyzer = new AlertAnalyzer({ debug: () => {}, error: () => {}, getSelfPath: () => undefined }, {}, {}, {}, { t: (k) => k });
    const depth = { key: 'notifications.environment.depth.belowTransducer', severity: 'alarm', category: 'safety' };
    const cpa = { key: 'notifications.navigation.closestApproach.urn:mrn:imo:mmsi:227', severity: 'alarm', category: 'navigation' };
    const engine = { key: 'notifications.propulsion.port.overTemperature', severity: 'alarm', category: 'engine' };

    analyzer.getMode = () => 'moored';
    assert.strictEqual(analyzer.shouldSpeak(depth), false);
    assert.strictEqual(analyzer.shouldSpeak(cpa), false);
    assert.strictEqual(analyzer.shouldSpeak(engine), true);

    analyzer.getMode = () => 'sailing';
    assert.strictEqual(analyzer.shouldSpeak(depth), true);
    assert.strictEqual(analyzer.shouldSpeak(cpa), true);
});
