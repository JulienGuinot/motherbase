import type { MetadataRoute } from 'next';

// Every URL is written out with the /studio mount: basePath prefixes the link
// to this file, not the paths inside it.
//
// `scope` has no trailing slash on purpose: the studio's entry URL is /studio,
// and a scope of /studio/ would leave the start page outside its own app.
//
// No service worker. Browsers install from the manifest alone, the console is
// useless offline, and a worker caching the bundle is one more way to serve a
// stale build after a deploy. In mock mode, MSW's worker already claims the
// origin (see next.config.mjs).
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/studio',
    name: 'Motherbase Studio',
    short_name: 'Motherbase',
    description: 'Manage your Motherbase projects, databases, storage and auth.',
    start_url: '/studio',
    scope: '/studio',
    display: 'standalone',
    // A manifest holds one colour per field, not one per scheme. These are the
    // light theme's --bg (src/index.css). Once the page has loaded, ThemeProvider
    // keeps <meta name="theme-color"> on the active theme.
    background_color: '#f0ede4',
    theme_color: '#f0ede4',
    icons: [
      { src: '/studio/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/studio/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // The logo's own margin keeps the mark inside the maskable safe zone.
      { src: '/studio/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
