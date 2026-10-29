import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'dist/', 'extension/vendor/', 'test/.build/', 'test/fixtures/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    files: ['test/**', 'scripts/**', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
];
