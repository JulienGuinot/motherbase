import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_MOTHERBASE_');
  if (env.VITE_MOTHERBASE_KEY?.startsWith('mb_secret_')) {
    throw new Error('Use a publishable key for the UI playground. Secret keys must stay server-side.');
  }
  return {
    resolve: {
      alias: {
        '@motherbase/contracts': fileURLToPath(new URL('../../contracts/src/index.ts', import.meta.url)),
      },
    },
  };
});
