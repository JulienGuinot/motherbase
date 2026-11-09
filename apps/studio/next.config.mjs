// Plain .mjs on purpose, NOT .ts. The API server loads this file at runtime
// through nextApp.prepare(), and the production image runs `npm prune
// --omit=dev`, so typescript is gone by then. Next reacted by shelling out to
// `yarn add typescript` inside the container on every boot, which blew the
// 512M heap and crash-looped the API (1486 restarts, every request 502).
// A .mjs config needs no compiler at runtime.

// The app is served under /studio by apps/server/console/server.ts only: a
// project's API image carries no UI. Next has no runtime basePath, so the prefix
// is fixed here.
// Routes that moved. Flat project paths were grouped under their product, and
// the console's System page became Org settings. These were <Navigate> routes
// in the react-router tree; here they cost nothing at runtime.
const MOVED = {
  '/p/:id': '/p/:id/overview',
  '/p/:id/database': '/p/:id/database/functions',
  '/p/:id/functions': '/p/:id/database/functions',
  '/p/:id/triggers': '/p/:id/database/triggers',
  '/p/:id/extensions': '/p/:id/database/extensions',
  '/p/:id/migrations': '/p/:id/database/migrations',
  '/p/:id/backups': '/p/:id/database/backups',
  '/p/:id/webhooks': '/p/:id/database/webhooks',
  '/p/:id/cron': '/p/:id/database/cron',
  '/p/:id/policies': '/p/:id/auth/policies',
  '/p/:id/auth/users': '/p/:id/auth',
  '/p/:id/reports': '/p/:id/observability',
  '/system': '/settings',
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: '/studio',
  // Dev and build wrote to the same .next. Running `npm run build` (turbo builds
  // studio too) while a dev server is up overwrote the dev manifests under it,
  // and the running server then 500s on every page with "Could not find the
  // module ... in the React Client Manifest". Separate directories, no collision.
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  reactStrictMode: true,
  async redirects() {
    return Object.entries(MOVED).map(([source, destination]) => ({
      source,
      destination,
      permanent: true,
    }));
  },
  async headers() {
    // Dev only. The MSW worker is a public asset, so basePath puts it at
    // /studio/mockServiceWorker.js, which by default limits its scope to
    // /studio/, and the studio's own entry URL is /studio, with no trailing
    // slash, so the page fell outside its own worker's scope and every request
    // escaped to the network. This lets it claim the whole origin instead.
    if (process.env.NODE_ENV !== 'development') return [];
    return [
      {
        source: '/mockServiceWorker.js',
        headers: [{ key: 'Service-Worker-Allowed', value: '/' }],
      },
    ];
  },
  webpack(config) {
    // Mock mode is dev-only: `npm run studio:mock` sets NEXT_PUBLIC_MOCK, and the
    // worker's header and the /api rewrite below are dev-only too. Without this
    // alias the production build still emits msw, a devDependency, as a ~280 kB
    // chunk nothing can fetch: the runtime guard sits inside an effect and
    // webpack does not prune the dynamic import in `app/client-gate.tsx` behind
    // it (tried both a literal `process.env` comparison at the import site and a
    // folded ternary; the chunk was emitted either way, so client-gate is left
    // as it was). Aliasing it to `false` in a production build is what actually
    // drops it: 283 kB -> 41 kB for that chunk, the remainder being this repo's
    // own handlers, which are harmless without the worker that would use them.
    if (process.env.NODE_ENV !== 'development') {
      config.resolve.alias['msw/browser'] = false;
      config.resolve.alias.msw = false;
    }
    return config;
  },
  async rewrites() {
    // Dev only. In production express owns /api and never forwards it to Next.
    // basePath: false keeps the source at /api instead of /studio/api, which is
    // where axios (baseURL '/api') actually sends its requests. The target is the
    // Console (`npm run console:dev`, CONSOLE_PORT), not a project's API.
    if (process.env.NODE_ENV !== 'development') return [];
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:5500/api/:path*',
        basePath: false,
      },
    ];
  },
};

export default nextConfig;
