import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const read = (name: string) => readFileSync(path.join(__dirname, '..', '..', '..', 'deploy', name), 'utf8');
const file = read('docker-compose.dev-multi.yml');

describe('docker-compose.dev-multi.yml', () => {
  it('has no TLS / Let\'s Encrypt config', () => {
    expect(file).not.toContain('certresolver');
    expect(file).not.toContain('letsencrypt');
    expect(file).not.toContain('websecure');
  });
  it('uses the http web entrypoint and http URLs', () => {
    expect(file).toContain('entrypoints=web');
    expect(file).not.toContain('https://');
  });
  it('keeps the admin/console deny middleware', () => {
    expect(file).toContain('ipAllowList.sourceRange=127.0.0.1/32');
  });
  it('carries the same api env var keys as prod (no silent drops)', () => {
    const apiEnv = (f: string) => Object.keys((yaml.load(read(f)) as any).services.api.environment);
    const prodKeys = apiEnv('docker-compose.prod.yml');
    const devKeys = apiEnv('docker-compose.dev-multi.yml');
    // API_PORT is the dev-only loopback port Connect reports: prod must never
    // forward it, or a VPS project would advertise http://localhost:<port>.
    expect(devKeys.filter(k => k !== 'API_PORT')).toEqual(prodKeys);
    expect(prodKeys).not.toContain('API_PORT');
  });
});

describe('traefik/docker-compose.dev.yml', () => {
  const dev = yaml.load(read('traefik/docker-compose.dev.yml')) as any;

  // Docker 29+ refuses API < 1.40; Traefik's embedded client asks for 1.24. The
  // dev Traefik must therefore go through the same version-rewriting nginx proxy
  // as prod, or it loads zero routers and every <name>.localhost answers 404.
  it('reaches the Docker API through the version-rewriting proxy', () => {
    expect(dev.services['docker-proxy']).toBeTruthy();
    expect(dev.services.traefik.command).toContain('--providers.docker.endpoint=http://docker-proxy:2375');
    expect(dev.services.traefik.volumes ?? []).not.toContain('/var/run/docker.sock:/var/run/docker.sock:ro');
  });
});
