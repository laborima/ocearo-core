const { test } = require('node:test');
const assert = require('node:assert');
const SignalKProvider = require('../src/dataprovider/signalk');

test('vessel data for the analysers: heel, speed through water, true wind angle, gusts', () => {
    const self = {
        navigation: {
            speedOverGround: { value: 3 }, speedThroughWater: { value: 2.8 }, headingTrue: { value: Math.PI / 2 },
            attitude: { value: { roll: -0.35, pitch: 0.02, yaw: 1.57 } }, state: { value: 'sailing' },
            position: { value: { latitude: 46.1, longitude: -1.2 } },
        },
        environment: {
            wind: { speedTrue: { value: 7 }, angleTrueWater: { value: -0.8 }, directionTrue: { value: 0.77 }, gust: { value: 10 } },
            current: { value: { setTrue: 1.2, drift: 0.5 } },
        },
    };
    const app = {
        debug: () => {}, error: () => {}, setPluginStatus: () => {},
        getSelfPath: (p) => p.split('.').reduce((o, k) => o?.[k], self),
    };
    const v = new SignalKProvider(app, 'ocearo-core').getVesselData();
    assert.strictEqual(v.attitude.roll, -20.1);
    assert.strictEqual(v.stw, 5.4);
    assert.strictEqual(v.wind.angle, -45.8);
    assert.strictEqual(v.wind.gust, 19.4);
    assert.strictEqual(v.state, 'sailing');
    assert.ok(v.environment.current);
});

test('battery and engine branches arrive as plain values, so failures are detected', async () => {
    const node = (value) => ({ value, $source: 'n2k.1', timestamp: '2026-10-05T10:00:00Z', meta: { units: 'V' } });
    const self = {
        electrical: { batteries: { 1: { voltage: node(11.2), current: node(-20), capacity: { stateOfCharge: node(0.4) } } } },
        propulsion: { main: { temperature: node(372), oilPressure: node(80000), revolutions: node(25) } },
    };
    const app = {
        debug: () => {}, error: () => {}, setPluginStatus: () => {},
        getSelfPath: (p) => p.split('.').reduce((o, k) => o?.[k], self),
    };
    const v = new SignalKProvider(app, 'ocearo-core').getVesselData();
    assert.strictEqual(v.electrical.batteries['1'].voltage, 11.2);
    assert.strictEqual(v.propulsion.main.temperature, 372);
    const FailurePredictor = require('../src/analyses/failure');
    const fp = new FailurePredictor(app, {}, { generateDualOutput: async () => null }, { t: (k) => k, language: 'en' });
    const issues = [];
    const warnings = [];
    fp._checkElectricalSystems(v, issues, warnings);
    fp._checkPropulsionSystems(v, issues, warnings);
    const types = issues.map(i => i.type).sort();
    assert.deepStrictEqual(types, ['low_oil_pressure', 'low_voltage', 'overheating']);
    assert.ok(warnings.some(w => w.type === 'rapid_discharge'));
});

test('failure advice is spoken in plain units, never as a locale key', () => {
    const FailurePredictor = require('../src/analyses/failure');
    const ConfigManager = require('../src/config');
    const app = { debug: () => {}, error: () => {} };
    const cm = new ConfigManager(app, { language: 'fr' });
    const fp = new FailurePredictor(app, {}, null, cm);
    const [a, b] = fp._generateExpertAdvice(
        [{ system: 'engine_main', type: 'overheating', value: 372 }],
        [{ system: 'battery_1', type: 'low_voltage', value: 11.24 }]);
    assert.match(a.message, /Surchauffe moteur main : 99 °C/);
    assert.match(b.message, /Batterie 1 basse : 11.2 volts/);
});
