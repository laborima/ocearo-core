const { test } = require('node:test');
const assert = require('node:assert');
const createPlugin = require('../index.js');

// The plugin's authentication middleware, taken from its router, run against fake requests
const authMiddleware = (allowReadOnly) => {
    const app = { debug() {}, error() {}, setPluginStatus() {}, securityStrategy: { allowReadOnly: () => allowReadOnly } };
    const plugin = createPlugin(app);
    const used = [];
    const router = new Proxy({}, { get: (_, method) => (...args) => { if (method === 'use') used.push(args[0]); } });
    plugin.registerWithRouter(router);
    // the third router.use(): rate limit, JSON check, then authentication
    return used.find((fn) => fn.length === 3 && /permission/.test(fn.toString()));
};
const run = (mw, req) => {
    let status = 200; let passed = false;
    const res = { status(s) { status = s; return this; }, json() { return this; } };
    mw({ isAuthenticated: () => !!req.user, ...req }, res, () => { passed = true; });
    return passed ? 'next' : status;
};

test('anonymous read-only access: reads pass, writes are refused', () => {
    const mw = authMiddleware(true);
    assert.ok(mw, 'auth middleware found');
    assert.strictEqual(run(mw, { method: 'GET' }), 'next');
    assert.strictEqual(run(mw, { method: 'POST' }), 401);
    assert.strictEqual(run(mw, { method: 'PUT' }), 401);
    assert.strictEqual(run(mw, { method: 'DELETE' }), 401);
});

test('writes need a user allowed to write', () => {
    const mw = authMiddleware(false);
    assert.strictEqual(run(mw, { method: 'POST', user: { type: 'read' } }), 401);
    assert.strictEqual(run(mw, { method: 'POST', user: { type: 'readwrite' } }), 'next');
    assert.strictEqual(run(mw, { method: 'POST', user: { type: 'admin' } }), 'next');
    assert.strictEqual(run(mw, { method: 'GET', user: { type: 'read' } }), 'next');
    assert.strictEqual(run(mw, { method: 'GET' }), 401);
});
