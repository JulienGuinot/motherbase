import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // tsconfig says jsx: "preserve" for Next, so the test transform has to do the
  // JSX itself. Vite 8 transforms with oxc and ignores the old `esbuild` option:
  // leaving it there means every .tsx test file fails to parse.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    clearMocks: true,
  },
});
