const { test } = require('node:test');
const assert = require('node:assert');
const LLMManager = require('../src/llm');

// An Ollama /api/chat stub that records the token budget of each request
const stub = (reply) => {
    const budgets = [];
    global.fetch = async (url, init) => {
        budgets.push(JSON.parse(init.body).options.num_predict);
        return { ok: true, json: async () => reply };
    };
    return budgets;
};

const manager = (llm = {}) => {
    const m = new LLMManager({ debug: () => {}, error: () => {} }, { language: 'en', llm }, { t: (k) => k });
    m.checkConnectionAsync = async () => true;
    return m;
};

test('dual output leaves room for reasoning models', async () => {
    const budgets = stub({ message: { content: 'Light wind.' }, done_reason: 'stop' });
    await manager().generateDualOutput('Wind 3 kn');
    assert.deepStrictEqual(budgets, [600, 1500]);
});

test('token budgets come from the AI settings', async () => {
    const budgets = stub({ message: { content: 'Light wind.' }, done_reason: 'stop' });
    await manager({ maxTokensSpeech: 120, maxTokensText: 400 }).generateDualOutput('Wind 3 kn');
    assert.deepStrictEqual(budgets, [120, 400]);
});

test('an answer cut off before it starts is reported, without opening the circuit', async () => {
    stub({ message: { content: '', thinking: 'The user wants...' }, done_reason: 'length' });
    const m = manager();
    await assert.rejects(m.generateCompletion('Wind 3 kn', { max_tokens: 80 }), /80-token budget ran out/);
    assert.strictEqual(m._consecutiveFailures, 0);
});
