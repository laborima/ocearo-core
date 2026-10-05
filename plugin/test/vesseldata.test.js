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
