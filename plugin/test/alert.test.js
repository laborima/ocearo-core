const { test } = require('node:test');
const assert = require('node:assert');
const AlertAnalyzer = require('../src/analyses/alert');

// Records how many alerts reach the AI and the memory
const setup = () => {
    const calls = { llm: 0, memory: 0 };
    const llm = {
        isConnected: () => true,
        processAlert: async () => { calls.llm++; return { speech: 'Low battery', text: 'Battery at 11.2 V' }; }
    };
    const memory = {
        getContext: () => ({}),
        wasRecentlySent: () => false,
        addAlert: (a) => { calls.memory++; return { id: calls.memory, ...a }; }
    };
    const analyzer = new AlertAnalyzer({ debug: () => {}, error: () => {} }, {}, llm, memory, { t: (key) => key });
    return { analyzer, calls };
};

// The flat shape built by SignalKDataProvider.getNotifications()
const flat = (state, message = 'Port Water in Fuel is Normal') => ({
    path: 'notifications.propulsion.port.waterInFuel',
    state,
    severity: state,
    message,
    timestamp: '2026-10-05T10:00:00Z',
    method: []
});

test('a flat notification keeps its real state and message', () => {
    const { analyzer } = setup();
    const alert = analyzer.parseNotification(flat('alarm', 'Battery voltage low'));
    assert.strictEqual(alert.severity, 'alarm');
    assert.strictEqual(alert.message, 'Battery voltage low');
});

test('the nested delta shape is still read', () => {
    const { analyzer } = setup();
    const alert = analyzer.parseNotification({ path: 'notifications.depth', value: { state: 'warn', message: 'Shallow' } });
    assert.strictEqual(alert.severity, 'warn');
    assert.strictEqual(alert.message, 'Shallow');
});

test('normal and nominal notifications cost no AI call and no memory entry', async () => {
    const { analyzer, calls } = setup();
    assert.strictEqual(await analyzer.processAlert(flat('normal'), {}), null);
    assert.strictEqual(await analyzer.processAlert(flat('nominal'), {}), null);
    assert.deepStrictEqual(calls, { llm: 0, memory: 0 });
});

test('a real alarm is analysed and spoken', async () => {
    const { analyzer, calls } = setup();
    const result = await analyzer.processAlert(flat('alarm', 'Battery voltage low'), {});
    assert.ok(result);
    assert.strictEqual(result.severity, 'alarm');
    assert.strictEqual(result.shouldSpeak, true);
    assert.strictEqual(calls.memory, 1);
});
