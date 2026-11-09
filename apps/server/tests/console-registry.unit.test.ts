import { describe, expect, it, vi } from 'vitest';
import { Registry } from '../console/services/registry.service';

describe('Registry', () => {
  it('lists projects from manifests and marks running ones from docker ps', async () => {
    const fsx = {
      readdir: vi.fn().mockResolvedValue(['projet-a', 'projet-b']),
      readFile: vi.fn().mockImplementation(async (p: string) =>
        JSON.stringify({
          name: p.includes('projet-a') ? 'projet-a' : 'projet-b',
          domain: 'd',
          storageDomain: 's',
          createdAt: 'x',
        }),
      ),
    };
    const exec = vi.fn().mockResolvedValue({ stdout: 'projet-a-api-1\n', stderr: '' });
    const reg = new Registry({ projectsDir: '/srv/projects' } as any, fsx as any, exec);
    const list = await reg.list();
    expect(list.map(p => p.name).sort()).toEqual(['projet-a', 'projet-b']);
    expect(list.find(p => p.name === 'projet-a')!.status).toBe('running');
    expect(list.find(p => p.name === 'projet-b')!.status).toBe('stopped');
  });

  it('spawns one docker ps for a burst of concurrent calls, and re-reads manifests every time', async () => {
    const fsx = {
      readdir: vi.fn().mockResolvedValue(['projet-a']),
      readFile: vi.fn().mockResolvedValue(
        JSON.stringify({ name: 'projet-a', domain: 'd', storageDomain: 's', createdAt: 'x' }),
      ),
    };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const exec = vi.fn(async () => {
      await gate;
      return { stdout: 'projet-a-api-1\n', stderr: '' };
    });
    const reg = new Registry({ projectsDir: '/srv/projects' } as any, fsx as any, exec);

    // What a single Studio page load looks like: several proxied admin requests
    // landing together, each one calling get() -> list().
    const burst = Promise.all([reg.list(), reg.get('projet-a'), reg.get('projet-a'), reg.list()]);
    release();
    await burst;

    expect(exec).toHaveBeenCalledTimes(1);

    // A later call inside the TTL still shares the sample.
    await reg.list();
    expect(exec).toHaveBeenCalledTimes(1);

    // Manifests are never cached: existence has to stay live so create/404/409
    // checks cannot be answered from a stale snapshot.
    expect(fsx.readdir.mock.calls.length).toBeGreaterThan(1);
  });

  it('lists projects as stopped when docker ps is unavailable', async () => {
    const fsx = {
      readdir: vi.fn().mockResolvedValue(['projet-a']),
      readFile: vi.fn().mockResolvedValue(
        JSON.stringify({
          name: 'projet-a',
          domain: 'd',
          storageDomain: 's',
          createdAt: 'x',
        }),
      ),
    };
    const reg = new Registry(
      { projectsDir: '/srv/projects' } as any,
      fsx as any,
      vi.fn().mockRejectedValue(new Error('spawn docker ENOENT')),
    );

    await expect(reg.list()).resolves.toEqual([
      { name: 'projet-a', domain: 'd', storageDomain: 's', createdAt: 'x', status: 'stopped' },
    ]);
  });
});

describe('Registry apiTarget', () => {
  // Mock exec that answers `docker ps` (container-name resolution) and
  // `docker inspect` (network membership) independently.
  function makeExec(opts: { psNames?: string; networks?: Record<string, { IPAddress?: string }> }) {
    return vi.fn().mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'ps') return Promise.resolve({ stdout: opts.psNames ?? '', stderr: '' });
      if (args[0] === 'inspect') {
        return Promise.resolve({ stdout: opts.networks ? JSON.stringify(opts.networks) : '', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
  }

  it('returns the stable DNS alias when the container is on the traefik network', async () => {
    const exec = makeExec({
      psNames: 'test2-api-1\n',
      networks: {
        test2_internal: { IPAddress: '172.21.0.4' },
        traefik_proxy: { IPAddress: '172.19.0.5' },
      },
    });
    const reg = new Registry(
      { projectsDir: '/srv/projects', traefikNetwork: 'traefik_proxy' },
      { readdir: vi.fn(), readFile: vi.fn() } as any,
      exec,
    );

    // Alias, never the inspected IP.
    await expect(reg.apiTarget('test2')).resolves.toBe('http://test2-api:5001');
    expect(exec).toHaveBeenCalledWith('docker', [
      'inspect',
      'test2-api-1',
      '--format',
      '{{json .NetworkSettings.Networks}}',
    ]);
  });

  it('does not return the internal-network IP when the container is not on traefik', async () => {
    const exec = makeExec({
      psNames: 'test2-api-1\n',
      networks: { test2_internal: { IPAddress: '172.21.0.4' } },
    });
    const reg = new Registry(
      { projectsDir: '/srv/projects', traefikNetwork: 'traefik_proxy' },
      { readdir: vi.fn(), readFile: vi.fn() } as any,
      exec,
    );

    // Falls back to undefined so callers use the `<name>-api` alias default.
    await expect(reg.apiTarget('test2')).resolves.toBeUndefined();
  });

  it('resolves the real container name from compose labels, not the -1 suffix', async () => {
    const exec = makeExec({
      psNames: 'test2-api-run-7fa\n',
      networks: { traefik_proxy: { IPAddress: '172.19.0.5' } },
    });
    const reg = new Registry(
      { projectsDir: '/srv/projects', traefikNetwork: 'traefik_proxy' },
      { readdir: vi.fn(), readFile: vi.fn() } as any,
      exec,
    );

    await expect(reg.apiTarget('test2')).resolves.toBe('http://test2-api:5001');
    expect(exec).toHaveBeenCalledWith('docker', [
      'inspect',
      'test2-api-run-7fa',
      '--format',
      '{{json .NetworkSettings.Networks}}',
    ]);
  });

  it('returns undefined for stopped/unknown projects (empty inspect output)', async () => {
    const exec = makeExec({ psNames: '', networks: undefined });
    const reg = new Registry(
      { projectsDir: '/srv/projects', traefikNetwork: 'traefik_proxy' },
      { readdir: vi.fn(), readFile: vi.fn() } as any,
      exec,
    );

    await expect(reg.apiTarget('test2')).resolves.toBeUndefined();
  });

  it('falls back to undefined when docker inspect is unavailable', async () => {
    const reg = new Registry(
      { projectsDir: '/srv/projects', traefikNetwork: 'traefik_proxy' },
      { readdir: vi.fn(), readFile: vi.fn() } as any,
      vi.fn().mockRejectedValue(new Error('docker unavailable')),
    );

    await expect(reg.apiTarget('test2')).resolves.toBeUndefined();
  });
});

describe('Registry apiTargets', () => {
  function makeExec(opts: { psNames?: string; networks?: Record<string, { IPAddress?: string }> }) {
    return vi.fn().mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'ps') return Promise.resolve({ stdout: opts.psNames ?? '', stderr: '' });
      if (args[0] === 'inspect') {
        return Promise.resolve({ stdout: opts.networks ? JSON.stringify(opts.networks) : '', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
  }

  function registry(exec: any) {
    return new Registry(
      { projectsDir: '/srv/projects', traefikNetwork: 'traefik_proxy' },
      { readdir: vi.fn(), readFile: vi.fn() } as any,
      exec,
    );
  }

  it('offers the container name and traefik IP as fallbacks behind the alias', async () => {
    const reg = registry(
      makeExec({
        psNames: 'test2-api-1\n',
        networks: {
          test2_internal: { IPAddress: '172.21.0.4' },
          traefik_proxy: { IPAddress: '172.19.0.5' },
        },
      }),
    );

    // The alias stays first (stable across recreates); the container name and the
    // traefik-network IP are the escape hatches when the alias was never registered.
    await expect(reg.apiTargets('test2')).resolves.toEqual([
      'http://test2-api:5001',
      'http://test2-api-1:5001',
      'http://172.19.0.5:5001',
    ]);
  });

  it('never offers an IP from a network the console is not attached to', async () => {
    const reg = registry(
      makeExec({ psNames: 'test2-api-1\n', networks: { test2_internal: { IPAddress: '172.21.0.4' } } }),
    );

    const targets = await reg.apiTargets('test2');
    expect(targets).not.toContain('http://172.21.0.4:5001');
    expect(targets[0]).toBe('http://test2-api:5001');
  });

  it('falls back to the alias alone when docker is unavailable', async () => {
    const reg = registry(vi.fn().mockRejectedValue(new Error('docker unavailable')));

    await expect(reg.apiTargets('test2')).resolves.toEqual(['http://test2-api:5001']);
  });
});

describe('resolveContainerName', () => {
  it('parses the first name from docker ps label output', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'test2-api-run-7fa\n', stderr: '' });
    const { resolveContainerName } = await import('../console/lib/docker');

    await expect(resolveContainerName(exec, 'test2')).resolves.toBe('test2-api-run-7fa');
    expect(exec).toHaveBeenCalledWith('docker', [
      'ps',
      '--filter',
      'label=com.docker.compose.project=test2',
      '--filter',
      'label=com.docker.compose.service=api',
      '--format',
      '{{.Names}}',
    ]);
  });

  it('falls back to <name>-api-1 when docker ps returns nothing', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '\n', stderr: '' });
    const { resolveContainerName } = await import('../console/lib/docker');

    await expect(resolveContainerName(exec, 'test2')).resolves.toBe('test2-api-1');
  });

  it('falls back to <name>-api-1 when docker ps errors', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('docker unavailable'));
    const { resolveContainerName } = await import('../console/lib/docker');

    await expect(resolveContainerName(exec, 'test2')).resolves.toBe('test2-api-1');
  });
});

describe('Registry platformToken', () => {
  it('keeps the full token value when it contains equals signs', async () => {
    const fsx = {
      readdir: vi.fn(),
      readFile: vi.fn().mockResolvedValue('JWT_SECRET=x\nPLATFORM_SERVICE_TOKEN=abc==\n'),
    };
    const reg = new Registry({ projectsDir: '/srv/projects' } as any, fsx as any, vi.fn());

    await expect(reg.platformToken('projet-a')).resolves.toBe('abc==');
  });
});
