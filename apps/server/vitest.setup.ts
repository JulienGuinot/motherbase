// Provide the minimum env the validated config requires so importing app
// modules during tests doesn't fail fast. Real values come from CI / .env.

// Load .env first so integration tests connect to the real DATABASE_URL
// (e.g. the local WSL Postgres on port 55432) instead of the bare defaults below.
 
require('dotenv').config();

process.env.JWT_SECRET ||= 'test-secret-at-least-32-characters-long';
process.env.DATABASE_URL ||= 'postgresql://postgres:postgres@localhost:55432/app?schema=public';
process.env.ACCESS_TOKEN_EXP_MIN ||= '15';
// SqlService defaults to the env flags, which are OFF unless an operator opts in.
process.env.CONSOLE_SQL_ENABLED ||= 'true';

// Register ts-node so awilix-router-core's findControllers() can CJS-require
// .ts files with experimental decorators (Node v22+ strip-only mode cannot).
// We also pre-populate require.cache for platform-admin.middleware so that
// vi.mock() is honoured when the controller is loaded via require().
try {
   
  require('ts-node').register({ transpileOnly: true, esm: false });

  // Seed require.cache with a no-op adminGuard so any vi.mock factory that
  // runs later (hoisted) will overwrite this, and any require() of the
  // middleware during loadControllers() will see the bypass stub.
  const path = require('path');
  const mwPath = path.resolve(__dirname, 'middlewares/platform-admin.middleware.ts');
  if (!require.cache[mwPath]) {
     
    const Module = require('module');
    const m = new Module(mwPath);
    m.filename = mwPath;
    m.loaded = true;
    m.exports = {
      adminGuard: (_req: any, _res: any, next: any) => next(),
    };
    require.cache[mwPath] = m;
  }
} catch {/* ts-node not available, skip */}
