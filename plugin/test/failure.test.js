const { test } = require('node:test');
const assert = require('node:assert');
const FailureAnalyzer = require('../src/analyses/failure');

const failures = () => new FailureAnalyzer({ debug: () => {}, error: () => {} }, {}, null, { t: (key) => key });
const check = (engine) => {
    const issues = [];
    const warnings = [];
    failures()._checkPropulsionSystems({ propulsion: { main: engine } }, issues, warnings);
    return issues.map(i => i.type);
};

test('no oil pressure is normal with the engine stopped', () => {
    assert.deepStrictEqual(check({ oilPressure: 0, revolutions: 0, state: 'stopped' }), []);
});

test('low oil pressure with the engine running is an issue', () => {
    assert.deepStrictEqual(check({ oilPressure: 50000, revolutions: 25 }), ['low_oil_pressure']);
    assert.deepStrictEqual(check({ oilPressure: 50000, state: 'started' }), ['low_oil_pressure']);
});
