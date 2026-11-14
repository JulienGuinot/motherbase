import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../console/services/orchestrator.service';

const cfg = { composeFile: '/repo/deploy/docker-compose.prod.yml', projectsDir: '/srv/projects', traefikNetwork: 'traefik_proxy' } as any;

function makeExec(networksJson = '{"traefik_proxy":{}}') {
  return vi.fn().mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'inspect' && args.includes('--format')) {
      return Promise.resolve({ stdout: networksJson, stderr: '' });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  });
}

describe('Orchestrator', () => {
  it('writes env + manifest and runs `compose up` on create', async () => {
    const fsx = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
    };
    const exec = makeExec();
    const orch = new Orchestrator(cfg, fsx as any, exec, () => 'y'.repeat(32));
    await orch.create({ name: 'projet-a', domain: 'projet-a.example.com' });
    // Path separators differ across OSes (path.join), so match agnostically.
    expect(fsx.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]srv[\\/]projects[\\/]projet-a[\\/]\.env\.prod$/),
      expect.any(String),
      expect.anything(),
    );
    expect(fsx.chmod).toHaveBeenCalledWith(expect.stringContaining('.env.prod'), 0o600);
    expect(exec).toHaveBeenCalledWith('docker', expect.arrayContaining(['compose', 'up', '-d']), expect.anything());
  });

  it('removes the project again when `compose up` fails on create, so the name stays free', async () => {
    const fsx = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
    };
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('up')) throw new Error('Orchestration operation failed: port is already allocated');
      return { stdout: '', stderr: '' };
    });
    const orch = new Orchestrator(cfg, fsx as any, exec, () => 'y'.repeat(32));

    await expect(orch.create({ name: 'projet-a', domain: 'projet-a.example.com' })).rejects.toThrow(/port is already allocated/);

    expect(exec).toHaveBeenCalledWith('docker', expect.arrayContaining(['down', '-v']), expect.anything());
    expect(fsx.rm).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]srv[\\/]projects[\\/]projet-a$/),
      { recursive: true, force: true },
    );
  });

  it('keeps the project directory when the rollback teardown fails too', async () => {
    const fsx = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
    };
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('up')) throw new Error('up failed');
      if (args.includes('down')) throw new Error('down failed');
      return { stdout: '', stderr: '' };
    });
    const orch = new Orchestrator(cfg, fsx as any, exec, () => 'y'.repeat(32));

    await expect(orch.create({ name: 'projet-a', domain: 'projet-a.example.com' })).rejects.toThrow('up failed');
    expect(fsx.rm).not.toHaveBeenCalled();
  });

  it('runs `compose down` without volumes on stop', async () => {
    const exec = makeExec();
    const orch = new Orchestrator(cfg, {} as any, exec, () => 'y'.repeat(32));
    await orch.stop('projet-a');
    expect(exec).toHaveBeenCalledWith('docker', expect.arrayContaining(['down', '--remove-orphans']), expect.anything());
    expect(exec.mock.calls[0][1]).not.toContain('-v');
  });

  it('destroys containers, volumes and the project manifest directory', async () => {
    const exec = makeExec();
    const fsx = { rm: vi.fn().mockResolvedValue(undefined) };
    const orch = new Orchestrator(cfg, fsx as any, exec, () => 'y'.repeat(32));

    await orch.destroy('projet-a');

    expect(exec).toHaveBeenCalledWith('docker', expect.arrayContaining(['down', '-v', '--remove-orphans']), expect.anything());
    expect(fsx.rm).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]srv[\\/]projects[\\/]projet-a$/),
      { recursive: true, force: true },
    );
  });

  it('derives <name>.localhost env in dev mode (no domain supplied)', async () => {
    const devCfg = {
      composeFile: '/repo/deploy/docker-compose.dev-multi.yml',
      projectsDir: '/repo/.dev-projects',
      scheme: 'http',
      domainSuffix: 'localhost',
    } as any;
    const fsx = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
    };
    const exec = makeExec();
    const orch = new Orchestrator(devCfg, fsx as any, exec, () => 'y'.repeat(32));
    await orch.create({ name: 'foo' } as any);
    const envWrite = fsx.writeFile.mock.calls.find(c => String(c[0]).endsWith('.env.prod'));
    expect(envWrite?.[1]).toContain('PROJECT_DOMAIN=foo.localhost');
    expect(envWrite?.[1]).toContain('CORS_ORIGINS=http://foo.localhost');
  });

  it('readLimits parses the limit vars out of .env.prod', async () => {
    const env = [
      'COMPOSE_PROJECT_NAME=projet-a',
      'API_CPUS=2',
      'API_MEM=1024M',
      'DB_CPUS=1',
      'DB_MEM=768M',
      'MINIO_CPUS=0.5',
      'MINIO_MEM=256M',
      '',
    ].join('\n');
    const fsx = { readFile: vi.fn().mockResolvedValue(env) };
    const orch = new Orchestrator(cfg, fsx as any, makeExec(), () => 'y'.repeat(32));
    const limits = await orch.readLimits('projet-a');
    // Absent vars (the edge runtime's, on a project older than them) read as the defaults.
    expect(limits).toEqual({ apiCpus: 2, apiMemMb: 1024, dbCpus: 1, dbMemMb: 768, minioCpus: 0.5, minioMemMb: 256, edgeCpus: 0.5, edgeMemMb: 768, diskGb: 10 });
  });

  it('reads and updates project config while preserving secrets and syncing the public manifest', async () => {
    const env = [
      'COMPOSE_PROJECT_NAME=projet-a',
      'PROJECT_DOMAIN=old.example.com',
      'STORAGE_DOMAIN=storage.example.com',
      'MINIO_CONSOLE_DOMAIN=minio.example.com',
      'CORS_ORIGINS=https://app.example.com',
      'API_IMAGE=motherbase-api:1.0.0',
      'CERT_RESOLVER=letsencrypt',
      'JWT_SECRET=keep-me',
      '',
    ].join('\n');
    const manifest = {
      name: 'projet-a',
      domain: 'old.example.com',
      storageDomain: 'storage.example.com',
      minioConsoleDomain: 'minio.example.com',
      corsOrigins: 'https://app.example.com',
      apiImage: 'motherbase-api:1.0.0',
      certResolver: 'letsencrypt',
    };
    const store: Record<string, string> = {
      '/srv/projects/projet-a/.env.prod': env,
      '/srv/projects/projet-a/manifest.json': JSON.stringify(manifest),
    };
    const fsx = {
      readFile: vi.fn(async (p: string) => store[p.replace(/\\/g, '/')] ?? Promise.reject(new Error('enoent'))),
      writeFile: vi.fn(async (p: string, data: string) => { store[p.replace(/\\/g, '/')] = data; }),
      chmod: vi.fn().mockResolvedValue(undefined),
    };
    const exec = makeExec();
    const orch = new Orchestrator(cfg, fsx as any, exec, () => 'y'.repeat(32));

    await expect(orch.readConfig('projet-a')).resolves.toMatchObject({ domain: 'old.example.com' });
    const updated = await orch.writeConfig('projet-a', {
      domain: 'api.example.com',
      corsOrigins: 'https://app.example.com,https://admin.example.com',
      apiImage: 'ghcr.io/acme/api:2.0.0',
    });

    expect(updated).toMatchObject({ domain: 'api.example.com', apiImage: 'ghcr.io/acme/api:2.0.0' });
    expect(store['/srv/projects/projet-a/.env.prod']).toContain('PROJECT_DOMAIN=api.example.com');
    expect(store['/srv/projects/projet-a/.env.prod']).toContain('JWT_SECRET=keep-me');
    expect(JSON.parse(store['/srv/projects/projet-a/manifest.json'])).toMatchObject(updated);
    expect(fsx.chmod).toHaveBeenCalledWith(expect.stringContaining('.env.prod'), 0o600);
    expect(exec).toHaveBeenCalledWith('docker', expect.arrayContaining(['up', '-d']), expect.anything());
  });

  it('writeLimits rewrites only the given limit lines and preserves everything else', async () => {
    const env = [
      '# Generated by the Console',
      'COMPOSE_PROJECT_NAME=projet-a',
      'JWT_SECRET=super-secret',
      'API_CPUS=0.5',
      'API_MEM=512M',
      'DB_CPUS=0.5',
      'DB_MEM=512M',
      'MINIO_CPUS=0.25',
      'MINIO_MEM=256M',
      '',
    ].join('\n');
    const store: Record<string, string> = {
      '/srv/projects/projet-a/.env.prod': env,
      '/srv/projects/projet-a/manifest.json': JSON.stringify({ name: 'projet-a', limits: {} }),
    };
    const fsx = {
      readFile: vi.fn(async (p: string) => store[p.replace(/\\/g, '/')] ?? Promise.reject(new Error('enoent'))),
      writeFile: vi.fn(async (p: string, data: string, _o?: any) => { store[p.replace(/\\/g, '/')] = data; }),
      chmod: vi.fn().mockResolvedValue(undefined),
    };
    const exec = makeExec();
    const orch = new Orchestrator(cfg, fsx as any, exec, () => 'y'.repeat(32));

    const applied = await orch.writeLimits('projet-a', { apiCpus: 4, apiMemMb: 2048 });

    // Only the api lines changed; db/minio and unrelated lines preserved verbatim.
    const written = store['/srv/projects/projet-a/.env.prod'];
    expect(written).toContain('API_CPUS=4');
    expect(written).toContain('API_MEM=2048M');
    expect(written).toContain('DB_CPUS=0.5');
    expect(written).toContain('MINIO_MEM=256M');
    expect(written).toContain('JWT_SECRET=super-secret');
    expect(written).toContain('COMPOSE_PROJECT_NAME=projet-a');
    // env written with restrictive mode
    const envWrite = fsx.writeFile.mock.calls.find(c => String(c[0]).endsWith('.env.prod'));
    expect(envWrite?.[2]).toMatchObject({ mode: 0o600 });
    // manifest.json limits mirrored
    expect(JSON.parse(store['/srv/projects/projet-a/manifest.json']).limits).toEqual(applied);
    // A quota change only recreates containers; it must never pull unrelated images.
    expect(exec).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['pull']), expect.anything());
    expect(exec).toHaveBeenCalledWith('docker', expect.arrayContaining(['up', '-d']), expect.anything());
    expect(applied.apiCpus).toBe(4);
    expect(applied.dbCpus).toBe(0.5); // unchanged merged in
  });

  it('writeLimits appends limit vars for a project that predates quotas', async () => {
    const env = 'COMPOSE_PROJECT_NAME=old\nJWT_SECRET=x\n';
    const store: Record<string, string> = { '/srv/projects/old/.env.prod': env };
    const fsx = {
      readFile: vi.fn(async (p: string) => store[p.replace(/\\/g, '/')] ?? Promise.reject(new Error('enoent'))),
      writeFile: vi.fn(async (p: string, data: string, _o?: any) => { store[p.replace(/\\/g, '/')] = data; }),
      chmod: vi.fn().mockResolvedValue(undefined),
    };
    const orch = new Orchestrator(cfg, fsx as any, makeExec(), () => 'y'.repeat(32));
    await orch.writeLimits('old', { dbCpus: 2 });
    const written = store['/srv/projects/old/.env.prod'];
    expect(written).toContain('DB_CPUS=2');
    expect(written).toContain('API_CPUS=0.5'); // defaults filled in for the rest
    expect(written).toContain('JWT_SECRET=x'); // original preserved
  });

  describe('writeRuntimeOptions', () => {
    function setup(env: string) {
      const store: Record<string, string> = { '/srv/projects/projet-a/.env.prod': env };
      const fsx = {
        readFile: vi.fn(async (p: string) => store[p.replace(/\\/g, '/')] ?? Promise.reject(new Error('enoent'))),
        writeFile: vi.fn(async (p: string, data: string, _o?: any) => { store[p.replace(/\\/g, '/')] = data; }),
        chmod: vi.fn().mockResolvedValue(undefined),
      };
      const exec = makeExec();
      const orch = new Orchestrator(cfg, fsx as any, exec, () => 'y'.repeat(32));
      const composeCalls = () => exec.mock.calls.filter(([, args]) => args[0] === 'compose');
      return { orch, composeCalls, written: () => store['/srv/projects/projet-a/.env.prod'] };
    }
    const env = 'COMPOSE_PROJECT_NAME=projet-a\nJWT_SECRET=s\nEDGE_RUNTIME_TOKEN=t\n';

    it('reads a project that predates the switches as edge on, never paused', async () => {
      expect(await setup(env).orch.readRuntimeOptions('projet-a')).toEqual({ edgeRuntime: true, autoPauseMinutes: 0 });
    });

    it('scales the edge runtime to 0 and reapplies a running stack', async () => {
      const { orch, composeCalls, written } = setup(env);
      const next = await orch.writeRuntimeOptions('projet-a', { edgeRuntime: false }, { apply: true });
      expect(next).toEqual({ edgeRuntime: false, autoPauseMinutes: 0 });
      expect(written()).toContain('EDGE_RUNTIME_REPLICAS=0');
      expect(written()).toContain('JWT_SECRET=s');
      expect(composeCalls()).toHaveLength(1);
      expect(composeCalls()[0][1]).toEqual(expect.arrayContaining(['up', '-d']));
    });

    it('does not start a stopped project to apply the edge switch', async () => {
      const { orch, composeCalls, written } = setup(env);
      await orch.writeRuntimeOptions('projet-a', { edgeRuntime: false }, { apply: false });
      expect(written()).toContain('EDGE_RUNTIME_REPLICAS=0');
      expect(composeCalls()).toHaveLength(0);
    });

    it('stores the auto-pause delay without touching the containers', async () => {
      const { orch, composeCalls, written } = setup(env);
      await orch.writeRuntimeOptions('projet-a', { autoPauseMinutes: 60 }, { apply: true });
      expect(written()).toContain('AUTO_PAUSE_MINUTES=60');
      expect(written()).toContain('EDGE_RUNTIME_REPLICAS=1');
      expect(composeCalls()).toHaveLength(0);
    });
  });

  describe('env backfill on compose calls', () => {
    function setup(env: string) {
      const store: Record<string, string> = { '/srv/projects/projet-a/.env.prod': env };
      const fsx = {
        readFile: vi.fn(async (p: string) => store[p.replace(/\\/g, '/')] ?? Promise.reject(new Error('enoent'))),
        writeFile: vi.fn(async (p: string, data: string, _o?: any) => { store[p.replace(/\\/g, '/')] = data; }),
        chmod: vi.fn().mockResolvedValue(undefined),
      };
      const orch = new Orchestrator(cfg, fsx as any, makeExec(), () => 'y'.repeat(32));
      return { orch, fsx, written: () => store['/srv/projects/projet-a/.env.prod'] };
    }

    it('gives a project that predates API_PORT the port derived from its DB_PORT', async () => {
      const { orch, written } = setup('JWT_SECRET=s\nEDGE_RUNTIME_TOKEN=t\nDB_PORT=54321\n');
      await orch.start('projet-a');
      expect(written()).toContain('API_PORT=54421');
      expect(written()).toContain('EDGE_RUNTIME_TOKEN=t');
    });

    it('leaves a complete env file untouched', async () => {
      const { orch, fsx } = setup('EDGE_RUNTIME_TOKEN=t\nDB_PORT=54321\nAPI_PORT=54421\n');
      await orch.start('projet-a');
      expect(fsx.writeFile).not.toHaveBeenCalled();
    });

    it('adds no API_PORT when the project has no DB_PORT to derive it from', async () => {
      const { orch, written } = setup('JWT_SECRET=s\n');
      await orch.start('projet-a');
      expect(written()).toContain('EDGE_RUNTIME_TOKEN=');
      expect(written()).not.toContain('API_PORT=');
    });
  });

  // The API runs as `node`, and cap_drop: ALL leaves root without DAC_OVERRIDE,
  // so a shell that landed as root could not read the volumes the server writes.
  it('shells into the API as the account the server runs as', () => {
    const exec = makeExec();
    const orch = new Orchestrator(cfg, {} as any, exec, () => 'y'.repeat(32));
    const shell = orch.shell('projet-a');
    expect(shell.command).toContain('docker compose');
    expect(shell.command).toContain('-p projet-a exec --user node api sh');
    expect(shell.args).toEqual(expect.arrayContaining(['exec', '--user', 'node', 'api', 'sh']));
  });

  // The other services run as their own image users; --user node would be wrong.
  it('leaves the other services on their own image user', () => {
    const exec = makeExec();
    const orch = new Orchestrator(cfg, {} as any, exec, () => 'y'.repeat(32));
    expect(orch.shell('projet-a', 'db').command).toContain('exec db sh');
    expect(orch.shell('projet-a', 'db').command).not.toContain('--user');
  });

  it('rejects invalid project and shell service names before Docker execution', async () => {
    const exec = makeExec();
    const orch = new Orchestrator(cfg, {} as any, exec, () => 'y'.repeat(32));

    await expect(orch.start('../escape')).rejects.toThrow('invalid project name');
    expect(() => orch.shell('projet-a', '--privileged')).toThrow('invalid compose service');
    expect(exec).not.toHaveBeenCalled();
  });

  it('serializes concurrent Docker mutations for the same project', async () => {
    let activeCompose = 0;
    let maxActiveCompose = 0;
    const exec = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'compose') {
        activeCompose += 1;
        maxActiveCompose = Math.max(maxActiveCompose, activeCompose);
        await new Promise(resolve => setTimeout(resolve, 5));
        activeCompose -= 1;
      }
      if (args[0] === 'inspect' && args.includes('--format')) {
        return { stdout: '{"traefik_proxy":{}}', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const orch = new Orchestrator(cfg, {} as any, exec, () => 'y'.repeat(32));

    await Promise.all([orch.start('projet-a'), orch.restart('projet-a')]);

    expect(maxActiveCompose).toBe(1);
  });
});
