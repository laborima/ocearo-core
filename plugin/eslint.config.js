// ESLint flat config (ESLint 9+): the recommended rules for a CommonJS
// Signal K plugin on Node, plus the node:test globals for the tests.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    { ignores: ['node_modules/**', 'coverage/**'] },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
        rules: {
            // Unused arguments are common in Express handlers and callbacks
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
        },
    },
];
