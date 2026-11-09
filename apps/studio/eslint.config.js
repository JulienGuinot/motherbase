import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // next-env.d.ts is generated and carries triple-slash references by design.
  globalIgnores(['.next', '.next-dev', 'next-env.d.ts', 'public/mockServiceWorker.js']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // Test doubles stand in for API responses and DOM handles; spelling out
    // those shapes only to cast them away adds noise, not safety.
    files: ['**/*.test.{ts,tsx}', 'src/mocks/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
])
