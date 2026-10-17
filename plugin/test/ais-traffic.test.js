const { test } = require('node:test');
const assert = require('node:assert');
const AisTrafficGate = require('../src/analyses/ais-traffic');

const MIN = 60_000;
// A vessel at risk as the AIS analyzer reports it (targets) and, when its
// announce cooldown allows, as an alert
const vessel = (mmsi, cpa = 0.1, tcpa = 5) => ({ mmsi, name: `V${mmsi}`, risk: 'danger', cpa, tcpa, range: 0.2 });
const alertOf = (v) => ({ mmsi: v.mmsi, target: v.name, severity: 'alarm', cpa: v.cpa, tcpa: v.tcpa, speech: `danger ${v.name}` });
const result = (targets, alerting = targets) => ({ targets, alerts: alerting.map(alertOf) });

test('one vessel: said, said once more, then not again for that encounter', () => {
    const gate = new AisTrafficGate();
    const v = vessel(1);
    assert.strictEqual(gate.update(result([v]), 0).alerts.length, 1);
    assert.strictEqual(gate.update(result([v]), 5 * MIN).alerts.length, 1);
    assert.strictEqual(gate.update(result([v]), 10 * MIN).alerts.length, 0);
});

test('the same vessel coming back later is a new encounter', () => {
    const gate = new AisTrafficGate();
    const v = vessel(1);
    gate.update(result([v]), 0);
    gate.update(result([v]), 5 * MIN);
    gate.update(result([]), 6 * MIN);
    assert.strictEqual(gate.update(result([v]), 20 * MIN).alerts.length, 1);
});

test('busy channel: one grouped announcement, repeated once, no alarm per vessel', () => {
    const gate = new AisTrafficGate();
    const fleet = [vessel(1, 0.14), vessel(2, 0.04), vessel(3, 0.2), vessel(4, 0.3)];
    const first = gate.update(result(fleet), 0);
    assert.strictEqual(first.busy, true);
    assert.strictEqual(first.alerts.length, 0);
    assert.strictEqual(first.group.count, 4);
    assert.strictEqual(first.group.nearest.mmsi, 2);
    assert.strictEqual(first.group.started, true);
    // every 15 s for the next minutes: silence until the single repeat
    let groups = 0;
    for (let t = 15_000; t <= 12 * MIN; t += 15_000) {
        const r = gate.update(result(fleet), t);
        assert.strictEqual(r.alerts.length, 0);
        if (r.group) { groups += 1; assert.strictEqual(r.group.repeat, true); }
    }
    assert.strictEqual(groups, 1);
});

test('busy waters: a vessel about to be on top of us is still announced', () => {
    const gate = new AisTrafficGate();
    const fleet = [vessel(1), vessel(2), vessel(3)];
    gate.update(result(fleet), 0);
    const close = vessel(9, 0.01, 1);
    const r = gate.update(result([...fleet, close], [close]), 15_000);
    assert.deepStrictEqual(r.alerts.map(a => a.mmsi), [9]);
});

test('back to calm after two minutes: a newcomer gets its own alert again', () => {
    const gate = new AisTrafficGate();
    gate.update(result([vessel(1), vessel(2), vessel(3)]), 0);
    assert.strictEqual(gate.update(result([vessel(1)], []), 1 * MIN).busy, true);
    assert.strictEqual(gate.update(result([], []), 3 * MIN + 1).busy, false);
    const newcomer = vessel(7);
    assert.strictEqual(gate.update(result([newcomer]), 4 * MIN).alerts.length, 1);
});

test('two vessels at risk do not make busy waters', () => {
    const gate = new AisTrafficGate();
    const r = gate.update(result([vessel(1), vessel(2)]), 0);
    assert.strictEqual(r.busy, false);
    assert.strictEqual(r.alerts.length, 2);
    assert.strictEqual(r.group, null);
});

test('reset (alongside, at anchor): busy waters do not carry over to the next departure', () => {
    const gate = new AisTrafficGate();
    const fleet = [vessel(1), vessel(2), vessel(3)];
    assert.strictEqual(gate.update(result(fleet), 0).busy, true);
    gate.reset();
    const after = gate.update(result([vessel(4)]), MIN);
    assert.strictEqual(after.busy, false);
    assert.strictEqual(after.alerts.length, 1);
});
