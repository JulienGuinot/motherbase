import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOrchestrationApp } from '../console/orchestration/app';
import { createOrchestrationExec, type OrchestrationClient } from '../console/orchestration/client';
import { DockerOrchestrationRuntime, type OrchestrationRuntimeApi } from '../console/orchestration/runtime';
import { DB_PORT_OVERLAY } from '../console/lib/compose';

const SECRET = 'orchestration-test-secret-at-least-32-characters';

function runtimeMock(): OrchestrationRuntimeApi {
  return {
    action: vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '' }),
    logs: vi.fn().mockResolvedValue({ stdout: 'logs', stderr: '' }),
    runningNames: vi.fn().mockResolvedValue([]),
    container: vi.fn().mockResolvedValue({ name: 'demo-api-1', networks: {} }),
    containerStats: vi.fn().mockResolvedValue({ lines: '' }),
    volumeUsage: vi.fn().mockResolvedValue({ lines: '' }),
    health: vi.fn().mockResolvedValue(undefined),
  };
}

describe('orchestration daemon HTTP boundary', () => {
  it('requires the internal bearer and exposes a Docker-backed health check', async () => {
    const runtime = runtimeMock();
    const app = createOrchestrationApp(runtime, SECRET, vi.fn());

    await request(app).get('/health').expect(200, { ok: true });
    await request(app).get('/v1/projects/running').expect(401, { error: 'Unauthorized' });
    expect(runtime.health).toHaveBeenCalledOnce();
  });

  it('accepts only strict slugs and allowlisted lifecycle actions', async () => {
    const runtime = runtimeMock();
    const app = createOrchestrationApp(runtime, SECRET, vi.fn());
    const auth = { authorization: `Bearer ${SECRET}` };

    await request(app).post('/v1/projects/demo/actions/restart').set(auth).expect(200);
    expect(runtime.action).toHaveBeenCalledWith('demo', 'restart');

    await request(app).post('/v1/projects/..%2Fescape/actions/down').set(auth).expect(400);
    await request(app).post('/v1/projects/demo/actions/exec').set(auth).expect(400);
    await request(app).post('/v1/exec').set(auth).send({ command: 'docker', args: ['ps'] }).expect(404);
  });

  it('reports the tail of a failed command stderr so the Console can log the cause', async () => {
    const runtime = runtimeMock();
    const failure = Object.assign(new Error('Command failed with exit code 1: docker compose up'), {
      stderr: `${'noise\n'.repeat(1000)}Error response from daemon: port is already allocated`,
    });
    vi.mocked(runtime.action).mockRejectedValueOnce(failure);
    vi.mocked(runtime.action).mockRejectedValueOnce(new Error('project manifest ownership mismatch'));
    const app = createOrchestrationApp(runtime, SECRET, vi.fn());
    const auth = { authorization: `Bearer ${SECRET}` };

    const stderr = await request(app).post('/v1/projects/demo/actions/up').set(auth).expect(500);
    expect(stderr.body.error.startsWith('Orchestration operation failed: ')).toBe(true);
    expect(stderr.body.error.endsWith('port is already allocated')).toBe(true);
    expect(stderr.body.error.length).toBeLessThan(2_100);

    const message = await request(app).post('/v1/projects/demo/actions/up').set(auth).expect(500);
    expect(message.body.error).toBe('Orchestration operation failed: project manifest ownership mismatch');
  });
});

describe('Console orchestration client compatibility boundary', () => {
  it('maps fixed Compose lifecycle and Docker reads to semantic calls', async () => {
    const client = {
      action: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      logs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      runningNames: vi.fn().mockResolvedValue(['demo-api-1']),
      container: vi.fn().mockResolvedValue({ name: 'demo-api-1', networks: { traefik_proxy: {} } }),
      containerStats: vi.fn().mockResolvedValue({ lines: '{"Name":"demo-api-1"}\n' }),
    } as unknown as OrchestrationClient;
    const exec = createOrchestrationExec(client);

    await exec('docker', ['compose', '-f', '/ignored', '--env-file', '/ignored', '-p', 'demo', 'up', '-d', '--force-recreate']);
    await exec('docker', ['ps', '--format', '{{.Names}}']);

    expect(client.action).toHaveBeenCalledWith('demo', 'restart');
    expect(client.runningNames).toHaveBeenCalledOnce();
    await expect(exec('docker', ['exec', 'demo-api-1', 'sh'])).rejects.toThrow('unsupported Docker operation');
    await expect(exec('sh', ['-c', 'docker ps'])).rejects.toThrow('only accepts Docker operations');
  });
});

describe('DockerOrchestrationRuntime', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  async function ownedProject(name = 'demo') {
    const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'motherbase-orchestration-'));
    temporaryDirectories.push(projectsDir);
    await mkdir(path.join(projectsDir, name));
    await writeFile(path.join(projectsDir, name, 'manifest.json'), JSON.stringify({ name }));
    await writeFile(path.join(projectsDir, name, '.env.prod'), 'COMPOSE_PROJECT_NAME=demo\n');
    return projectsDir;
  }

  it('builds exact argv from fixed configuration and filters host container data', async () => {
    const projectsDir = await ownedProject();
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === 'ps' && args.includes('--filter')) return { stdout: 'demo-api-1\n', stderr: '' };
      if (args[0] === 'ps') return { stdout: 'demo-api-1\nunrelated-api-1\n', stderr: '' };
      if (args[0] === 'stats') {
        return { stdout: '{"Name":"demo-api-1"}\n{"Name":"unrelated-api-1"}\n', stderr: '' };
      }
      if (args[0] === 'inspect') return { stdout: '{}', stderr: '' };
      if (args[0] === 'system') return { stdout: 'demo_db_data\t1.2GB\ndemo-two_db_data\t1kB\nunrelated_db_data\t9GB\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const runtime = new DockerOrchestrationRuntime(
      { composeFile: '/app/deploy/docker-compose.prod.yml', projectsDir, traefikNetwork: 'traefik_proxy' },
      exec,
    );

    await runtime.action('demo', 'down');
    expect(exec).toHaveBeenCalledWith('docker', [
      'compose',
      '-f',
      '/app/deploy/docker-compose.prod.yml',
      // The db-port overlay is merged into every project stack; see compose.ts.
      '-f',
      path.join('/app/deploy', DB_PORT_OVERLAY),
      '--env-file',
      path.join(projectsDir, 'demo', '.env.prod'),
      '-p',
      'demo',
      'down',
      '-v',
      '--remove-orphans',
    ], { cwd: '/app/deploy' });
    expect(await runtime.runningNames()).toEqual(['demo-api-1']);
    expect((await runtime.containerStats()).lines).toBe('{"Name":"demo-api-1"}\n');
    // "demo-two" is not owned and must not match the "demo" prefix.
    expect((await runtime.volumeUsage()).lines).toBe('demo_db_data\t1.2GB\n');

    await runtime.action('demo', 'up');
    expect(exec).toHaveBeenCalledWith('docker', [
      'network',
      'connect',
      '--alias',
      'demo-api',
      'traefik_proxy',
      'demo-api-1',
    ]);
  });

  it('rejects traversal and manifest ownership mismatch before Docker execution', async () => {
    const projectsDir = await ownedProject();
    const exec = vi.fn();
    const runtime = new DockerOrchestrationRuntime(
      { composeFile: '/fixed/compose.yml', projectsDir, traefikNetwork: 'traefik_proxy' },
      exec,
    );

    await expect(runtime.action('../escape', 'down')).rejects.toThrow('invalid project slug');
    await writeFile(path.join(projectsDir, 'demo', 'manifest.json'), JSON.stringify({ name: 'other' }));
    await expect(runtime.action('demo', 'down')).rejects.toThrow('ownership mismatch');
    expect(exec).not.toHaveBeenCalled();
  });
});
