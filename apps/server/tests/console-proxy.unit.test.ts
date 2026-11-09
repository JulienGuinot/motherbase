import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  applyAdminProxyHeaders,
  jsonBodyForProxy,
  proxyErrorBody,
  resolveEdgeTarget,
  resolveTarget,
  adminProxyCapability,
  stripSameOriginCorsHeaders,
} from '../console/routes/proxy.routes';

describe('resolveTarget', () => {
  it('maps /api/projects/:id/admin/x to the project api host and strips the prefix', () => {
    const t = resolveTarget('projet-a', '/api/projects/projet-a/admin/tables');
    expect(t.target).toBe('http://projet-a-api:5001');
    expect(t.rewrittenPath).toBe('/api/admin/tables');
  });

  it('maps public project edge routes to the project API without admin prefix', () => {
    const t = resolveEdgeTarget('projet-a', '/api/projects/projet-a/edge/hello');
    expect(t.target).toBe('http://projet-a-api:5001');
    expect(t.rewrittenPath).toBe('/api/edge/hello');
  });

  it('builds the X-Platform-Token header from the registry token', async () => {
    const reg = { platformToken: vi.fn().mockResolvedValue('tok-123'), get: vi.fn().mockResolvedValue({ name: 'projet-a' }) };
    const headers = await (await import('../console/routes/proxy.routes')).proxyHeaders(reg as any, 'projet-a');
    expect(headers['X-Platform-Token']).toBe('tok-123');
  });

  it('injects the platform token into the upstream request and strips console Authorization', () => {
    const req = {
      headers: {
        authorization: 'Bearer console-session',
        origin: 'https://console.example.com',
        referer: 'https://console.example.com/p/test/api',
      },
    } as any;

    applyAdminProxyHeaders(req, { 'X-Platform-Token': 'project-platform-token' });

    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers.origin).toBeUndefined();
    expect(req.headers.referer).toBeUndefined();
    expect(req.headers['x-platform-token']).toBe('project-platform-token');
  });

  it('strips same-origin browser CORS headers before console REST proxying', () => {
    const req = {
      headers: {
        host: 'console.example.com',
        origin: 'https://console.example.com',
        referer: 'https://console.example.com/p/test/api',
      },
    } as any;

    stripSameOriginCorsHeaders(req);

    expect(req.headers.origin).toBeUndefined();
    expect(req.headers.referer).toBeUndefined();
  });

  it('never forwards the console session cookie or platform headers upstream', () => {
    const req = {
      headers: {
        host: 'console.example.com',
        origin: 'https://console.example.com',
        cookie: 'console.session_token=abc',
        'x-platform-token': 'forged',
        'x-platform-operator': 'forged',
      },
    } as any;

    stripSameOriginCorsHeaders(req);

    expect(req.headers.cookie).toBeUndefined();
    expect(req.headers['x-platform-token']).toBeUndefined();
    expect(req.headers['x-platform-operator']).toBeUndefined();
  });

  it('drops the session cookie on a top-level navigation that carries no Origin', () => {
    const req = { headers: { host: 'console.example.com', cookie: 'console.session_token=abc' } } as any;

    stripSameOriginCorsHeaders(req);

    expect(req.headers.cookie).toBeUndefined();
  });

  it('keeps external browser origins on public REST proxy requests', () => {
    const req = {
      headers: {
        host: 'console.example.com',
        origin: 'http://localhost:3000',
        referer: 'http://localhost:3000',
      },
    } as any;

    stripSameOriginCorsHeaders(req);

    expect(req.headers.origin).toBe('http://localhost:3000');
    expect(req.headers.referer).toBe('http://localhost:3000');
  });

  it('serializes parsed JSON bodies for proxied admin writes', () => {
    const body = jsonBodyForProxy({
      headers: { 'content-type': 'application/json' },
      body: { name: 'hello', code: 'return true' },
      readableLength: 0,
    });

    expect(body).toBe('{"name":"hello","code":"return true"}');
  });

  it('picks the first reachable candidate target', async () => {
    const probe = vi.fn(async (url: string) => url.startsWith('http://test-api-1:5001'));
    const { selectUpstream } = await import('../console/routes/proxy.routes');

    await expect(
      selectUpstream(['http://test-api:5001', 'http://test-api-1:5001', 'http://172.19.0.5:5001'], probe, []),
    ).resolves.toBe('http://test-api-1:5001');
    // Stops at the first hit: the traefik IP is never probed.
    expect(probe).not.toHaveBeenCalledWith('http://172.19.0.5:5001/api/health-check');
  });

  it('retries the whole candidate list before giving up on a starting stack', async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const { selectUpstream } = await import('../console/routes/proxy.routes');

    await expect(selectUpstream(['http://a:5001', 'http://b:5001'], probe, [0, 0])).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(6); // 2 candidates x 3 attempts
  });

  it('resolves an unreachable project to its first candidate so the proxy still emits 502', async () => {
    const { resolveUpstream } = await import('../console/routes/proxy.routes');
    const registry = { apiTargets: vi.fn().mockResolvedValue(['http://test-api:5001', 'http://test-api-1:5001']) };

    const resolved = await resolveUpstream(registry as any, 'test', async () => false, [0]);

    expect(resolved).toEqual({ target: 'http://test-api:5001', ready: false });
  });

  it('caches a reachable target and re-probes once it is invalidated', async () => {
    const { resolveUpstream, invalidateUpstream } = await import('../console/routes/proxy.routes');
    const apiTargets = vi.fn().mockResolvedValue(['http://cached-api:5001']);
    const registry = { apiTargets };

    await resolveUpstream(registry as any, 'cached', async () => true, [0]);
    await resolveUpstream(registry as any, 'cached', async () => true, [0]);
    expect(apiTargets).toHaveBeenCalledTimes(1);

    invalidateUpstream('cached');
    await resolveUpstream(registry as any, 'cached', async () => true, [0]);
    expect(apiTargets).toHaveBeenCalledTimes(2);
  });

  it('caches an unreachable project so a down stack is not re-probed per request', async () => {
    const { resolveUpstream, invalidateUpstream } = await import('../console/routes/proxy.routes');
    const apiTargets = vi.fn().mockResolvedValue(['http://down-api:5001']);
    const probe = vi.fn().mockResolvedValue(false);
    invalidateUpstream('down');

    const first = await resolveUpstream({ apiTargets } as any, 'down', probe, [0]);
    const second = await resolveUpstream({ apiTargets } as any, 'down', probe, [0]);

    // Both still report the failure, but the second answered from cache: an
    // unauthenticated /rest burst against a dead project cannot amplify into a
    // probe storm.
    expect(first).toEqual({ target: 'http://down-api:5001', ready: false });
    expect(second).toEqual({ target: 'http://down-api:5001', ready: false });
    expect(apiTargets).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(2); // one pass x 2 attempts, not two passes
  });

  it('does not let a negative cache entry outlive a recovering project', async () => {
    const { invalidateUpstream, UNREACHABLE_TTL_MS } = await import('../console/routes/proxy.routes');
    // The negative entry has to expire on its own: nothing invalidates it when a
    // container comes back, since no request reaches the proxy error handler.
    expect(UNREACHABLE_TTL_MS).toBeLessThan(5_000);
    invalidateUpstream('recovering');
  });

  it('falls back to the legacy single-target registry contract', async () => {
    const { resolveUpstream } = await import('../console/routes/proxy.routes');
    const registry = { apiTarget: vi.fn().mockResolvedValue(undefined) };

    const resolved = await resolveUpstream(registry as any, 'legacy', async () => true, [0]);

    expect(resolved.target).toBe('http://legacy-api:5001');
  });

  it('never exposes upstream details in proxy error bodies', () => {
    expect(proxyErrorBody(500)).toEqual({ success: false, message: 'Proxy request failed' });
    expect(proxyErrorBody(502)).toEqual({ success: false, message: 'Project service unavailable' });
    expect(JSON.stringify(proxyErrorBody(502))).not.toContain('internal-host');
  });

  it('logs internal REST failures without exposing them to clients', async () => {
    const app = express();
    const logs = { push: vi.fn() };
    const registry = { get: vi.fn().mockRejectedValue(new Error('postgres://secret@internal-host')) };
    const { proxyRouter } = await import('../console/routes/proxy.routes');

    app.use('/api', proxyRouter({ registry, requireSession: (_req, _res, next) => next(), logs }));

    const res = await request(app).get('/api/projects/test/rest/items');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, message: 'Proxy request failed' });
    expect(JSON.stringify(res.body)).not.toContain('internal-host');
    expect(logs.push).toHaveBeenCalledWith(expect.objectContaining({
      level: 'error',
      message: expect.stringContaining('postgres://secret@internal-host'),
    }));
  });

  it('records proxy metrics only for projects that exist', async () => {
    const app = express();
    const { proxyRouter } = await import('../console/routes/proxy.routes');
    const { proxyMetrics } = await import('../console/services/proxy-metrics.service');
    proxyMetrics.reset();

    app.use('/api', proxyRouter({ registry: { get: vi.fn().mockResolvedValue(null) }, requireSession: (_req, _res, next) => next() }));

    expect((await request(app).get('/api/projects/ghost/rest/items')).status).toBe(404);
    expect((await request(app).get('/api/projects/ghost/edge/fn')).status).toBe(404);
    expect(proxyMetrics.snapshot()).toEqual([]);
  });

  it('does not run the proxy guard for unrelated /api routes', async () => {
    const app = express();
    const guard = vi.fn((_req, _res, next) => next());
    const { proxyRouter } = await import('../console/routes/proxy.routes');

    app.use('/api', proxyRouter({ registry: {}, requireSession: guard }));
    app.get('/api/auth/login', (_req, res) => res.status(200).json({ ok: true }));

    const res = await request(app).get('/api/auth/login');
    expect(res.status).toBe(200);
    expect(guard).not.toHaveBeenCalled();
  });
});

describe('adminProxyCapability', () => {
  it.each([
    ['GET', '/api/projects/foo/admin/settings/email.smtp', 'secrets.manage'],
    ['GET', '/api/projects/foo/admin/settings/%E0%A4%A', 'secrets.manage'],
    ['GET', '/api/projects/foo/admin/settings/server.cors', 'project.read'],
    ['GET', '/api/projects/foo/admin/edge-secrets', 'secrets.manage'],
    ['GET', '/api/projects/foo/admin/storage/buckets/assets/tokens', 'secrets.manage'],
    ['GET', '/api/projects/foo/admin/storage/s3/keys', 'secrets.manage'],
    ['POST', '/api/projects/foo/admin/storage/s3/keys', 'secrets.manage'],
    ['GET', '/api/projects/foo/admin/integrations', 'secrets.manage'],
    ['HEAD', '/api/projects/foo/admin/tables', 'project.read'],
    ['POST', '/api/projects/foo/admin/edge-secrets', 'secrets.manage'],
    ['DELETE', '/api/projects/foo/admin/storage/buckets/assets/tokens/token-1?force=true', 'secrets.manage'],
    ['POST', '/api/projects/foo/admin/backups/run', 'runtime.manage'],
    ['PUT', '/api/projects/foo/admin/backups/config', 'settings.write'],
    ['PUT', '/api/projects/foo/admin/realtime/config', 'settings.write'],
    ['PUT', '/api/projects/foo/admin/settings/email.smtp', 'secrets.manage'],
    ['PUT', '/api/projects/foo/admin/settings/server.cors', 'settings.write'],
    ['POST', '/api/projects/foo/admin/settings/email/test', 'settings.write'],
    ['POST', '/api/projects/foo/admin/integrations/stripe/connect', 'secrets.manage'],
    ['POST', '/api/projects/foo/admin/import/supabase?preview=true', 'secrets.manage'],
    ['POST', '/api/projects/foo/admin/unknown-future-route', 'settings.write'],
    ['POST', '/api/projects/foo/admin/tables', 'content.write'],
    // A project id that merely starts with "admin" is not the admin surface.
    ['GET', '/api/projects/admin-shop/admin/edge-secrets', 'secrets.manage'],
    ['GET', '/api/projects/admin-shop/admin/tables', 'project.read'],
    ['GET', '/api/projects/foo/admin/backups/download', 'runtime.manage'],
  ])('%s %s requires %s', (method, url, capability) => {
    expect(adminProxyCapability(method, url)).toBe(capability);
  });
});
