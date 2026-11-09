import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Type-level tests for the generated-`Database` generics. These
    // never execute: vitest runs tsc over them and reports type errors, and
    // unsatisfied `@ts-expect-error` markers, as test failures.
    typecheck: {
      enabled: true,
      include: ['tests/**/*.test-d.ts'],
      tsconfig: './tsconfig.typetest.json',
    },
  },
});
