import { describe, it, expect, vi } from 'vitest';
import {
  UpdateService,
  parseSemver,
  compareSemver,
  isNewer,
  pickLatest,
  extractVersions,
} from '../console/services/update.service';

describe('semver helpers', () => {
  it('parses and rejects', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver('v2.0.10')).toEqual({ major: 2, minor: 0, patch: 10 });
    expect(parseSemver('latest')).toBeNull();
    expect(parseSemver('1.2')).toBeNull();
  });

  it('compares by precedence', () => {
    expect(compareSemver({ major: 1, minor: 0, patch: 0 }, { major: 1, minor: 0, patch: 0 })).toBe(0);
    expect(compareSemver({ major: 1, minor: 2, patch: 0 }, { major: 1, minor: 10, patch: 0 })).toBe(-1);
    expect(compareSemver({ major: 2, minor: 0, patch: 0 }, { major: 1, minor: 9, patch: 9 })).toBe(1);
  });

  it('isNewer only when strictly greater and both parse', () => {
    expect(isNewer('1.1.0', '1.0.0')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.9.0', '1.0.0')).toBe(false);
    expect(isNewer('latest', '1.0.0')).toBe(false);
  });

  it('pickLatest ignores non-semver and takes the max', () => {
    expect(pickLatest(['1.0.0', 'latest', '1.2.0', 'v1.1.9'])).toBe('1.2.0');
    expect(pickLatest(['latest', 'edge'])).toBeNull();
  });

  it('extractVersions understands the accepted shapes', () => {
    expect(extractVersions({ version: '1.2.3' })).toEqual(['1.2.3']);
    expect(extractVersions({ tags: ['1.0.0', '1.1.0'] })).toEqual(['1.0.0', '1.1.0']);
    expect(extractVersions({ results: [{ name: '1.0.0' }, { name: '2.0.0' }] })).toEqual(['1.0.0', '2.0.0']);
    expect(extractVersions(null)).toEqual([]);
  });
});

describe('UpdateService.check', () => {
  it('reports not-configured when no channel URL is set', async () => {
    const svc = new UpdateService({ updateCheckUrl: '', version: '1.0.0' });
    const s = await svc.check();
    expect(s).toMatchObject({ current: '1.0.0', latest: null, updateAvailable: false, configured: false });
  });

  it('flags an update when the channel has a newer version (Docker Hub shape)', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ results: [{ name: '1.0.0' }, { name: '1.3.0' }, { name: 'latest' }] }), {
          status: 200,
        })
    );
    const svc = new UpdateService({ updateCheckUrl: 'https://hub/x', version: '1.0.0', fetchImpl: fetchImpl as any });
    const s = await svc.check();
    expect(s.latest).toBe('1.3.0');
    expect(s.updateAvailable).toBe(true);
    expect(s.configured).toBe(true);
  });

  it('does not flag when already on the latest', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: '2.0.0' }), { status: 200 }));
    const svc = new UpdateService({
      updateCheckUrl: 'https://m/manifest.json',
      version: '2.0.0',
      fetchImpl: fetchImpl as any,
    });
    const s = await svc.check();
    expect(s.latest).toBe('2.0.0');
    expect(s.updateAvailable).toBe(false);
  });

  it('surfaces an error on non-2xx or unreachable channel without throwing', async () => {
    const bad = new UpdateService({
      updateCheckUrl: 'https://x',
      version: '1.0.0',
      fetchImpl: (async () => new Response('e', { status: 502 })) as any,
    });
    expect((await bad.check()).error).toMatch(/502/);
    const down = new UpdateService({
      updateCheckUrl: 'https://x',
      version: '1.0.0',
      fetchImpl: (async () => {
        throw new Error('down');
      }) as any,
    });
    expect((await down.check()).error).toMatch(/unreachable/i);
  });

  it('delegates the configurable channel to the safe client with its deadline', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: '1.1.0' }), { status: 200 }));
    const svc = new UpdateService({
      updateCheckUrl: 'https://releases.example.com/manifest.json',
      version: '1.0.0',
      timeoutMs: 1234,
      httpClient: { request },
    });

    const status = await svc.check();

    expect(status.updateAvailable).toBe(true);
    expect(request).toHaveBeenCalledWith('https://releases.example.com/manifest.json', { timeoutMs: 1234 });
  });

  it('rejects a private release channel without using global fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const svc = new UpdateService({
      updateCheckUrl: 'http://127.0.0.1/releases.json',
      version: '1.0.0',
    });

    const status = await svc.check();

    expect(status.error).toMatch(/unreachable/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('UpdateService.plan', () => {
  it('builds a selective plan with guided commands when an update is available', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: '1.3.0' }), { status: 200 }));
    const svc = new UpdateService({ updateCheckUrl: 'https://m/x', version: '1.0.0', fetchImpl: fetchImpl as any });
    const plan = await svc.plan();

    expect(plan).toMatchObject({ current: '1.0.0', latest: '1.3.0', updateAvailable: true, configured: true });
    expect(plan.services).toEqual([
      { name: 'console', from: '1.0.0', to: '1.3.0' },
      { name: 'orchestrator', from: '1.0.0', to: '1.3.0' },
    ]);
    // Pull + recreate + migrate, scoped to the two motherbase services.
    expect(plan.commands.join('\n')).toContain('docker compose -f deploy/console/docker-compose.yml pull console orchestrator');
    expect(plan.commands.join('\n')).toContain('up -d console orchestrator');
    expect(plan.commands.join('\n')).toContain('prisma migrate deploy');
    // No secrets ever appear in guidance.
    expect(plan.commands.join('\n')).not.toMatch(/password|secret|postgres:\/\//i);
  });

  it('returns an empty plan when already up to date', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: '2.0.0' }), { status: 200 }));
    const svc = new UpdateService({ updateCheckUrl: 'https://m/x', version: '2.0.0', fetchImpl: fetchImpl as any });
    const plan = await svc.plan();
    expect(plan.updateAvailable).toBe(false);
    expect(plan.services).toEqual([]);
    expect(plan.commands).toEqual([]);
  });

  it('returns an empty plan (no error) when the channel is not configured', async () => {
    const svc = new UpdateService({ updateCheckUrl: '', version: '1.0.0' });
    const plan = await svc.plan();
    expect(plan).toMatchObject({ configured: false, updateAvailable: false });
    expect(plan.services).toEqual([]);
    expect(plan.commands).toEqual([]);
  });

  it('honors custom stack compose path and service names', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: '1.1.0' }), { status: 200 }));
    const svc = new UpdateService({
      updateCheckUrl: 'https://m/x',
      version: '1.0.0',
      fetchImpl: fetchImpl as any,
      stackComposePath: '/opt/mb/console.yml',
      stackServices: ['console'],
    });
    const plan = await svc.plan();
    expect(plan.services).toEqual([{ name: 'console', from: '1.0.0', to: '1.1.0' }]);
    expect(plan.commands.join('\n')).toContain('docker compose -f /opt/mb/console.yml pull console');
  });
});
