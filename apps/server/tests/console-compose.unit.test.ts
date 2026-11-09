import { describe, it, expect } from 'vitest';
import { readFileSync as readRaw } from 'fs';
import path from 'path';
import { composeArgs, DB_PORT_OVERLAY } from '../console/lib/compose';

// Compared against LF literals below; a CRLF checkout (Windows autocrlf) must not matter.
const readFileSync = (file: string, encoding: BufferEncoding) => readRaw(file, encoding).replace(/\r\n/g, '\n');

const ctx = { composeFile: '/repo/deploy/docker-compose.prod.yml', envFile: '/srv/projects/projet-a/.env.prod', project: 'projet-a' };

describe('composeArgs', () => {
  it('builds an up command', () => {
    expect(composeArgs(ctx, 'up')).toEqual([
      'compose',
      '-f',
      ctx.composeFile,
      // The db-port overlay rides along with every project stack; see compose.ts.
      '-f',
      path.join(path.dirname(ctx.composeFile), DB_PORT_OVERLAY),
      '--env-file',
      ctx.envFile,
      '-p',
      'projet-a',
      'up',
      '-d',
      '--remove-orphans',
    ]);
  });

  it('pulls only registry-backed services', () => {
    const args = composeArgs(ctx, 'pull');
    expect(args).toEqual(expect.arrayContaining(['pull', 'minio', 'minio-init']));
    expect(args).not.toContain('api');
    expect(args).not.toContain('db');
  });

  it('builds start/stop/restart/down', () => {
    // start uses up -d so it creates containers if they don't exist yet
    expect(composeArgs(ctx, 'start')).toEqual(expect.arrayContaining(['up', '-d']));
    expect(composeArgs(ctx, 'stop')).toEqual(expect.arrayContaining(['down', '--remove-orphans']));
    expect(composeArgs(ctx, 'stop')).not.toContain('-v');
    expect(composeArgs(ctx, 'down')).toEqual(expect.arrayContaining(['down', '-v', '--remove-orphans']));
    expect(composeArgs(ctx, 'restart')).toEqual(expect.arrayContaining(['up', '-d', '--force-recreate']));
    expect(composeArgs(ctx, 'restart')).not.toContain('restart');
  });

  it('pulls a configured registry API only when requested', () => {
    expect(composeArgs(ctx, 'pull', { pullApi: true })).toEqual(
      expect.arrayContaining(['pull', 'minio', 'minio-init', 'api']),
    );
  });

  it('never returns a single shell string (injection-safe argv)', () => {
    const args = composeArgs({ ...ctx, project: 'a; rm -rf /' }, 'up');
    expect(args).toContain('a; rm -rf /');
    expect(args.every(a => typeof a === 'string')).toBe(true);
  });
});

describe('deploy/console/docker-compose.yml', () => {
  const file = readFileSync(path.join(__dirname, '..', '..', '..', 'deploy', 'console', 'docker-compose.yml'), 'utf8');

  it('keeps the Console router above project and legacy single-stack routers', () => {
    expect(file).toContain('traefik.http.routers.console.priority=1000');
  });

  it('isolates Docker access in the internal orchestration daemon', () => {
    const orchestrationBlock = file.slice(file.indexOf('  orchestrator:'), file.indexOf('  console:'));
    const consoleBlock = file.slice(file.indexOf('  console:'), file.indexOf('\nnetworks:'));
    const consoleDockerfile = readFileSync(
      path.join(__dirname, '..', 'console', 'Dockerfile'),
      'utf8',
    );
    const daemonDockerfile = readFileSync(
      path.join(__dirname, '..', 'console', 'Orchestration.Dockerfile'),
      'utf8',
    );

    expect(file).toContain('orchestrator:');
    expect(file).toContain('/var/run/docker.sock:/var/run/docker.sock:ro');
    expect(file).toContain('orchestration:\n    internal: true');
    expect(orchestrationBlock).toContain('/root/.docker');
    expect(consoleBlock).not.toContain('/var/run/docker.sock');
    expect(consoleBlock).not.toContain('DOCKER_HOST');
    expect(consoleBlock).toContain('TRUST_PROXY: ${TRUST_PROXY:-1}');
    expect(consoleDockerfile).not.toContain('docker-cli');
    expect(daemonDockerfile).toContain('docker-cli');
  });

  it('trusts the Traefik hop in every project stack', () => {
    // Without it req.ip is Traefik's container address, so the whole stack
    // shares one rate-limit bucket and one client 429s everybody.
    for (const file of ['docker-compose.prod.yml', 'docker-compose.dev-multi.yml']) {
      const contents = readFileSync(path.join(__dirname, '..', '..', '..', 'deploy', file), 'utf8');
      expect(contents).toContain('TRUST_PROXY: ${TRUST_PROXY:-1}');
    }
  });
});
