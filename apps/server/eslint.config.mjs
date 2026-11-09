import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

// Flat config. It replaces a legacy .eslintrc that had no TypeScript parser and
// therefore linted none of the server's .ts files while still exiting 0.
export default defineConfig([
  globalIgnores(['dist', 'prisma/migrations', 'motherbase']),
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    rules: {
      // Deliberate escape hatches used across the admin/service layer where the
      // shape is dictated by Prisma, pg, or operator-supplied JSON.
      '@typescript-eslint/no-explicit-any': 'off',
      // `ignoreRestSiblings` keeps the omit idiom legal: `const { passwordHash,
      // ...safe } = user` is how sensitive fields are stripped before a response.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // `esbuild` is loaded lazily via require() on purpose, so an install
      // without the platform binary fails when an import needs it, with a
      // readable message, not when an unrelated file imports it.
      '@typescript-eslint/no-require-imports': 'off',
      // Best-effort cleanup paths (disposing an isolate, closing a handle) where
      // a failure is genuinely nothing to act on.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Both are forced by Express's own typings: `Request<{}, {}, Body>` to
      // reach the body generic, and `interface User extends PrismaUser {}`
      // inside `declare global { namespace Express }` to augment the module.
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-namespace': 'off',
    },
  },
  {
    files: ['**/*.{js,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'commonjs',
    },
  },
]);
