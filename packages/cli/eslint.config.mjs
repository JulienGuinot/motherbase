import js from '@eslint/js';
import globals from 'globals';
import { defineConfig } from 'eslint/config';

// The CLI is plain CommonJS JavaScript, so this stays on the JS recommended set
// rather than the TypeScript config the other packages use.
export default defineConfig([
  {
    files: ['**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'commonjs',
      parserOptions: { ecmaVersion: 'latest' },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
]);
