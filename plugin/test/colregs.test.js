const { test } = require('node:test');
const assert = require('node:assert');
const colregs = require('../src/analyses/colregs');
const AISAnalyzer = require('../src/analyses/ais');

// A target `range` metres away on true bearing `brg` (degrees)
const at = (brg, range) => ({ x: range * Math.sin(brg * Math.PI / 180), y: range * Math.cos(brg * Math.PI / 180) });

test('rule 18: a sailing yacht keeps clear of a vessel engaged in fishing', () => {
    const r = colregs.rightOfWay(
        { course: 0, speed: 6, category: 'sail' },
        { ...at(30, 800), course: 300, speed: 3, category: 'fishing' }, 90);
    assert.strictEqual(r.ownRole, 'give-way');
    assert.strictEqual(r.rule, '18');
});

test('rule 18: a power-driven vessel keeps clear of us under sail', () => {
    const r = colregs.rightOfWay(
        { course: 0, speed: 6, category: 'sail' },
        { ...at(60, 900), course: 270, speed: 12, category: 'power' }, 90);
    assert.strictEqual(r.ownRole, 'stand-on');
    assert.strictEqual(r.reason, 'stand_on_from_power');
});

test('rule 12: port tack keeps clear of starboard tack, windward keeps clear on the same tack', () => {
    // Wind from the north. Heading 45 (wind on port bow) = port tack
    const portTack = colregs.rightOfWay(
        { course: 45, speed: 6, category: 'sail' },
        { ...at(90, 600), course: 315, speed: 6, category: 'sail' }, 0);
    assert.deepStrictEqual([portTack.ownRole, portTack.rule], ['give-way', '12a-i']);
    // Both on starboard tack (heading 315), target abeam to windward, same speed
    const leeward = colregs.rightOfWay(
        { course: 315, speed: 6, category: 'sail' },
        { ...at(45, 300), course: 315, speed: 6, category: 'sail' }, 0);
    assert.deepStrictEqual([leeward.ownRole, leeward.rule], ['stand-on', '12a-ii']);
});

test('rule 14 head-on and rule 15 crossing between power-driven vessels', () => {
    const headOn = colregs.advise({
        own: { course: 0, speed: 10, category: 'power' },
        target: { ...at(2, 2000), course: 180, speed: 10, category: 'power' },
        twd: null, cpaNm: 0.05, tcpaMin: 6,
    });
    assert.deepStrictEqual([headOn.ownRole, headOn.rule, headOn.action], ['both', '14', 'head_on_starboard']);
    const crossing = colregs.advise({
        own: { course: 0, speed: 10, category: 'power' },
        target: { ...at(45, 2000), course: 270, speed: 10, category: 'power' },
        twd: null, cpaNm: 0.1, tcpaMin: 6,
    });
    assert.deepStrictEqual([crossing.ownRole, crossing.rule, crossing.action], ['give-way', '15', 'give_way_starboard']);
});

test('rule 13: a faster vessel coming up from astern must keep clear', () => {
    const r = colregs.rightOfWay(
        { course: 0, speed: 5, category: 'sail' },
        { ...at(180, 500), course: 0, speed: 12, category: 'power' }, 90);
    assert.deepStrictEqual([r.ownRole, r.rule], ['stand-on', '13']);
});

test('rule 17: the stand-on vessel holds, gets ready, then must act', () => {
    const base = {
        own: { course: 0, speed: 6, category: 'sail' },
        target: { ...at(60, 900), course: 270, speed: 12, category: 'power' },
        twd: 90,
    };
    assert.strictEqual(colregs.advise({ ...base, cpaNm: 0.2, tcpaMin: 12 }).action, 'stand_on');
    assert.strictEqual(colregs.advise({ ...base, cpaNm: 0.2, tcpaMin: 6 }).action, 'stand_on_ready');
    const act = colregs.advise({ ...base, cpaNm: 0.05, tcpaMin: 3 });
    assert.deepStrictEqual([act.action, act.rule], ['stand_on_act', '17b']);
});

test('rule 19: no stand-on vessel in restricted visibility', () => {
    const r = colregs.advise({
        own: { course: 0, speed: 6, category: 'sail' },
        target: { ...at(30, 900), course: 270, speed: 12, category: 'power' },
        twd: 90, cpaNm: 0.1, tcpaMin: 5, visibilityNm: 0.5,
    });
    assert.deepStrictEqual([r.ownRole, r.rule, r.action], ['give-way', '19', 'restricted_visibility']);
});

test('categories: motor-sailing is power-driven; AIS status beats ship type', () => {
    assert.strictEqual(colregs.ownCategory({ navState: 'sailing', engineRunning: true }), 'power');
    assert.strictEqual(colregs.ownCategory({ navState: 'sailing' }), 'sail');
    assert.strictEqual(colregs.targetCategory({ navState: 'engaged in fishing', shipType: 36 }), 'fishing');
    assert.strictEqual(colregs.targetCategory({ shipType: 36 }), 'sail');
    assert.strictEqual(colregs.targetCategory({ shipType: 70 }), 'power');
});

test('AIS analysis: a fishing vessel ahead, spoken with the rule and the action', () => {
    const own = { latitude: 46.14, longitude: -1.2 };
    // 0.4 NM ahead slightly to starboard, crossing from starboard to port, 4 kn
    const tgt = { latitude: own.latitude + 0.4 / 60, longitude: own.longitude + 0.05 / 60 };
    const self = {
        navigation: {
            position: { value: own }, speedOverGround: { value: 6 / 1.94384 }, courseOverGroundTrue: { value: 0 },
            state: { value: 'sailing' },
        },
        environment: { wind: { directionTrue: { value: Math.PI / 2 } } },
    };
    const app = {
        selfId: 'urn:mrn:signalk:uuid:self',
        debug: () => {},
        getPath: (p) => (p === 'vessels' ? {
            'urn:mrn:signalk:uuid:self': self,
            'urn:mrn:imo:mmsi:228000001': {
                name: { value: 'LE PERTUIS' },
                navigation: {
                    position: { value: tgt }, speedOverGround: { value: 4 / 1.94384 },
                    courseOverGroundTrue: { value: 268 * Math.PI / 180 }, state: { value: 'engaged in fishing' },
                },
                design: { aisShipType: { value: { id: 30, name: 'Fishing' } } },
            },
        } : undefined),
        getSelfPath: (p) => p.split('.').reduce((o, k) => o?.[k], self),
    };
    const cm = { t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key) };
    const ais = new AISAnalyzer(app, {}, null, cm);
    const result = ais.checkCollisionRisks({ navigation: self.navigation });
    assert.strictEqual(result.totalInRange, 1, 'own vessel is not a target');
    const [t] = result.targets;
    assert.deepStrictEqual([t.category, t.role, t.rule], ['fishing', 'give-way', '18']);
    assert.ok(result.alerts.length === 1 && result.alerts[0].mmsi === 'urn:mrn:imo:mmsi:228000001');
    assert.deepStrictEqual([result.alerts[0].role, result.alerts[0].rule, result.alerts[0].action], ['give-way', '18', 'give_way_starboard']);
    assert.ok(result.alerts[0].message.length > 0);
    // Same situation 15 s later: within the cooldown, not repeated
    assert.strictEqual(ais.checkCollisionRisks({ navigation: self.navigation }).alerts.length, 0);
});
