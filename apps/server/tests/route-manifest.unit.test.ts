import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { readRouteManifest } from '../lib/route-manifest';
import { renderRouteDocs } from '../lib/route-docs';

/**
 * The published route table used to say "Extracted from the decorators" while
 * being maintained by hand, and it had drifted: the four controllers that mount
 * on a `HTTP_ROUTES` constant were documented with their UNRESOLVED paths, so
 * every path copied out of the docs 404'd, and `HEAD /rest/v1/:model` was
 * missing entirely.
 *
 * These tests are the reason that cannot happen again.
 */
describe('route manifest', () => {
  const manifest = readRouteManifest();

  it('finds the whole controller surface', () => {
    expect(manifest.length).toBeGreaterThan(150);
    expect(new Set(manifest.map(route => route.source)).size).toBe(
      fs.readdirSync(path.join(__dirname, '..', 'controllers'), { recursive: true, encoding: 'utf8' })
        .filter(name => name.endsWith('.controller.ts')).length,
    );
  });

  // The actual regression. Every one of these is a base path that only exists as
  // a `HTTP_ROUTES.*` constant in the decorator.
  it.each([
    ['GET', '/rest/v1/:model'],
    ['HEAD', '/rest/v1/:model'],
    ['POST', '/rest/v1/rpc/:fn'],
    ['POST', '/api/edge/:route'],
    ['POST', '/realtime/v1/api/broadcast'],
    ['POST', '/api/files'],
    ['GET', '/api/files/:id/url'],
  ])('resolves %s %s rather than emitting the bare sub-path', (method, routePath) => {
    expect(manifest).toContainEqual(expect.objectContaining({ method, path: routePath }));
  });

  // A controller mounted at `@route('/')` under a base yields the base itself.
  // Express matches `/api/files` and `/api/files/` alike (strict routing is off),
  // so the manifest publishes the canonical form rather than both.
  it('canonicalises a bare mount to its base, with no trailing slash', () => {
    for (const routePath of ['/api/files', '/api/devices', '/api/users']) {
      expect(manifest.some(route => route.path === routePath)).toBe(true);
      expect(manifest.some(route => route.path === `${routePath}/`)).toBe(false);
    }
  });

  // A controller can mount under an existing base with a template literal
  // (`${HTTP_ROUTES.files}/bucket`) rather than re-typing the literal. The
  // parser has to resolve that, or the manifest silently loses the controller.
  it('resolves a template-literal class base', () => {
    const buckets = manifest.filter(route => route.path.startsWith('/api/files/bucket'));
    expect(buckets.length).toBeGreaterThan(0);
    for (const route of buckets) {
      expect(route.guards).toContain('requireSecretKey');
    }
  });

  it('never emits an unresolved path', () => {
    for (const route of manifest) {
      expect(route.path.startsWith('/')).toBe(true);
      // A path that is just the method's own sub-route means the class base was
      // dropped: exactly the shape of the original bug.
      expect(route.path).not.toBe('/:model');
      expect(route.path).not.toBe('/:route');
      expect(route.path).not.toBe('/');
    }
  });

  it('captures the guard chain, in order', () => {
    const restGet = manifest.find(route => route.method === 'GET' && route.path === '/rest/v1/:model');
    expect(restGet?.guards).toEqual(['optionalAuthMiddleware', 'apiKeyMiddleware', 'restApiLimiter']);
    // Order matters: apiKeyMiddleware reads req.user to build the caller, so it
    // has to run after auth and before anything that acts on the caller.

    // Truncated guard strings like `streamUpload.single('file'` in the old table
    // were the fingerprint of a throwaway extraction script. Nothing should be
    // able to emit an unbalanced one now.
    for (const route of manifest) {
      for (const guard of route.guards) {
        const opens = (guard.match(/\(/g) ?? []).length;
        const closes = (guard.match(/\)/g) ?? []).length;
        expect(opens, `unbalanced guard "${guard}"`).toBe(closes);
      }
    }
  });

  it('is stable: two reads produce the same manifest', () => {
    expect(readRouteManifest()).toEqual(manifest);
  });
});

describe('docs/admin-routes.md', () => {
  const committed = path.resolve(__dirname, '..', '..', '..', 'docs', 'admin-routes.md');

  it('is up to date with the decorators', () => {
    const onDisk = fs.existsSync(committed) ? fs.readFileSync(committed, 'utf8') : '';
    expect(
      onDisk.replace(/\r\n/g, '\n'),
      'docs/admin-routes.md is stale: run `npm run docs:routes`',
    ).toBe(renderRouteDocs().replace(/\r\n/g, '\n'));
  });
});
