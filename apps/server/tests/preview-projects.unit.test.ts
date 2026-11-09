import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import {
  decide,
  expiredPreviews,
  isPreviewProject,
  previewProjectName,
  type PreviewConfig,
} from '../console/services/preview.service';
import { previewRouter, sweepPreviews } from '../console/routes/preview.routes';
import { verifyHubSignature as verifySignature } from '../lib/webhook-signature';

// Preview projects: a stack per pull request. Two things here can cost real
// money or real data, so they carry the assertions. An unsigned request must
// never provision, and a sweep must never destroy a stack it cannot date.

const SECRET = 'webhook-secret';
const CONFIG: PreviewConfig = { enabled: true, repoAllowlist: ['acme/app'], ttlHours: 72 };

const prEvent = (action: string, extra: Record<string, unknown> = {}) => ({
  action,
  pull_request: { number: 42, head: { ref: 'feat/thing' }, ...extra },
  repository: { full_name: 'acme/app' },
});

describe('previewProjectName', () => {
  it('is stable for a pull request across events', () => {
    // A synchronize must update the stack the open created, not make a second.
    expect(previewProjectName('acme/app', 42)).toBe(previewProjectName('acme/app', 42));
  });

  it('is a DNS label, because it becomes a subdomain', () => {
    const name = previewProjectName('ACME/My_Weird.Repo!!', 7);
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it('does not depend on the branch, which can be renamed mid-PR', () => {
    expect(previewProjectName('acme/app', 42)).toBe('pr-42-app');
  });

  it('recognises its own names and nothing else', () => {
    expect(isPreviewProject('pr-42-app')).toBe(true);
    // A real customer project must never look sweepable.
    expect(isPreviewProject('client-a')).toBe(false);
    expect(isPreviewProject('pr-abc-app')).toBe(false);
  });
});

describe('decide', () => {
  it('creates on open, reopen and synchronize', () => {
    for (const action of ['opened', 'reopened', 'synchronize']) {
      expect(decide(prEvent(action), CONFIG)).toMatchObject({ action: 'create', project: 'pr-42-app' });
    }
  });

  it('destroys on close', () => {
    expect(decide(prEvent('closed'), CONFIG)).toMatchObject({ action: 'destroy', project: 'pr-42-app' });
  });

  it('ignores a draft until it is marked ready', () => {
    // A database per work-in-progress push is how this becomes a surprise bill.
    expect(decide(prEvent('opened', { draft: true }), CONFIG)).toMatchObject({ action: 'ignore' });
    expect(decide(prEvent('ready_for_review', { draft: true }), CONFIG)).toMatchObject({ action: 'create' });
  });

  it('fails closed on an empty allowlist', () => {
    const open = { ...CONFIG, repoAllowlist: [] };
    expect(decide(prEvent('opened'), open)).toMatchObject({ action: 'ignore' });
  });

  it('refuses a repository that is not allowlisted', () => {
    const evil = { ...prEvent('opened'), repository: { full_name: 'attacker/spend-your-disk' } };
    expect(decide(evil, CONFIG)).toMatchObject({ action: 'ignore' });
  });

  it('ignores everything while disabled', () => {
    expect(decide(prEvent('opened'), { ...CONFIG, enabled: false })).toMatchObject({ action: 'ignore' });
  });

  it('ignores a payload that is not a pull request', () => {
    expect(decide({ action: 'opened' }, CONFIG)).toMatchObject({ action: 'ignore' });
    expect(decide({}, CONFIG)).toMatchObject({ action: 'ignore' });
  });
});

describe('verifySignature', () => {
  const body = Buffer.from('{"hello":"world"}');
  const sign = (b: Buffer, secret = SECRET) =>
    'sha256=' + crypto.createHmac('sha256', secret).update(b).digest('hex');

  it('accepts a correct signature', () => {
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a body that was altered after signing', () => {
    expect(verifySignature(Buffer.from('{"hello":"evil"}'), sign(body), SECRET)).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(verifySignature(body, sign(body, 'other'), SECRET)).toBe(false);
  });

  it('rejects a missing header and an unconfigured secret', () => {
    expect(verifySignature(body, '', SECRET)).toBe(false);
    // A receiver with no secret verifies nothing, so it must accept nothing.
    expect(verifySignature(body, sign(body), '')).toBe(false);
  });
});

describe('webhook route', () => {
  const build = () => {
    const orchestrator = {
      create: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
    };
    const registry = { get: vi.fn(async () => undefined), list: vi.fn(async () => []) };
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 201 })) as unknown as typeof fetch;
    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
        },
      }),
    );
    app.use(
      '/api/preview',
      previewRouter({
        orchestrator,
        registry,
        config: { ...CONFIG, secret: SECRET, githubToken: 'gh-token', scheme: 'https', domainSuffix: 'example.com' },
        fetchImpl,
      }),
    );
    return { app, orchestrator, registry, fetchImpl };
  };

  const post = (app: express.Express, payload: object, event = 'pull_request', secret = SECRET) => {
    const body = JSON.stringify(payload);
    const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
    return request(app)
      .post('/api/preview/github')
      .set('content-type', 'application/json')
      .set('x-github-event', event)
      .set('x-hub-signature-256', signature)
      .send(body);
  };

  it('401s an unsigned request and provisions nothing', async () => {
    const { app, orchestrator } = build();
    const res = await request(app)
      .post('/api/preview/github')
      .set('x-github-event', 'pull_request')
      .send(prEvent('opened'));
    expect(res.status).toBe(401);
    expect(orchestrator.create).not.toHaveBeenCalled();
  });

  it('401s a request signed with the wrong secret', async () => {
    const { app, orchestrator } = build();
    const res = await post(app, prEvent('opened'), 'pull_request', 'not-the-secret');
    expect(res.status).toBe(401);
    expect(orchestrator.create).not.toHaveBeenCalled();
  });

  it('answers a ping', async () => {
    const { app } = build();
    const res = await post(app, {}, 'ping');
    expect(res.status).toBe(200);
    expect(res.body.pong).toBe(true);
  });

  it('provisions on a signed open, and comments back', async () => {
    const { app, orchestrator, fetchImpl } = build();
    const res = await post(app, prEvent('opened'));
    expect(res.body).toMatchObject({ action: 'create', project: 'pr-42-app' });
    // The handler answers before provisioning, so let the detached work run.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(orchestrator.create).toHaveBeenCalledWith({ name: 'pr-42-app' });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: any[][] } }).mock.calls[0];
    expect(url).toContain('/repos/acme/app/issues/42/comments');
    expect(JSON.parse(init.body).body).toContain('https://pr-42-app.example.com');
  });

  it('restarts rather than recreating when the stack already exists', async () => {
    const { app, orchestrator, registry } = build();
    registry.get = vi.fn(async () => ({ name: 'pr-42-app' })) as any;
    await post(app, prEvent('synchronize'));
    await new Promise(resolve => setTimeout(resolve, 20));
    // Recreating would drop the database a reviewer had set up.
    expect(orchestrator.create).not.toHaveBeenCalled();
    expect(orchestrator.restart).toHaveBeenCalledWith('pr-42-app');
  });

  it('tears down on close', async () => {
    const { app, orchestrator } = build();
    await post(app, prEvent('closed'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(orchestrator.destroy).toHaveBeenCalledWith('pr-42-app');
  });

  it('ignores a non-allowlisted repository even when correctly signed', async () => {
    const { app, orchestrator } = build();
    const res = await post(app, { ...prEvent('opened'), repository: { full_name: 'attacker/x' } });
    expect(res.body.ignored).toMatch(/allowlisted/);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(orchestrator.create).not.toHaveBeenCalled();
  });
});

describe('sweepPreviews', () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

  it('destroys only expired preview projects', async () => {
    const destroy = vi.fn(async () => undefined);
    const swept = await sweepPreviews({
      orchestrator: { destroy },
      registry: {
        list: async () => [
          { name: 'pr-1-app', createdAt: hoursAgo(100) },
          { name: 'pr-2-app', createdAt: hoursAgo(1) },
          { name: 'client-a', createdAt: hoursAgo(10_000) },
        ],
      },
      config: CONFIG,
    });
    expect(swept).toEqual(['pr-1-app']);
    // A real project is never a sweep candidate, however old it is.
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('never destroys a project whose date it cannot read', () => {
    // Leaving a stack up costs disk. Destroying a database on a bad date string
    // has no equivalent undo.
    expect(expiredPreviews([{ name: 'pr-9-app', createdAt: 'not a date' }], CONFIG)).toEqual([]);
    expect(expiredPreviews([{ name: 'pr-9-app' }], CONFIG)).toEqual([]);
  });

  it('sweeps nothing when the TTL is disabled', () => {
    const old = [{ name: 'pr-1-app', createdAt: hoursAgo(10_000) }];
    expect(expiredPreviews(old, { ...CONFIG, ttlHours: 0 })).toEqual([]);
  });

  it('keeps sweeping after one teardown fails', async () => {
    const destroy = vi.fn(async (name: string) => {
      if (name === 'pr-1-app') throw new Error('docker unavailable');
    });
    await sweepPreviews({
      orchestrator: { destroy },
      registry: {
        list: async () => [
          { name: 'pr-1-app', createdAt: hoursAgo(100) },
          { name: 'pr-2-app', createdAt: hoursAgo(100) },
        ],
      },
      config: CONFIG,
    });
    expect(destroy).toHaveBeenCalledTimes(2);
  });
});
