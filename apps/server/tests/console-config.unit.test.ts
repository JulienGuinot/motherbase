import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const KEYS = ['CONSOLE_MODE', 'PROJECTS_DIR', 'COMPOSE_FILE'];
let saved: Record<string, string | undefined>;

async function loadConfig() {
  // Reset module registry so config.ts re-evaluates process.env on each call.
  vi.resetModules();
  const mod = await import('../console/config');
  return mod.consoleConfig;
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('consoleConfig', () => {
  it('defaults to prod: https scheme, no suffix, /srv/projects, prod compose', async () => {
    const cfg = await loadConfig();
    expect(cfg.mode).toBe('prod');
    expect(cfg.scheme).toBe('https');
    expect(cfg.domainSuffix).toBe('');
    expect(cfg.projectsDir).toBe('/srv/projects');
    expect(cfg.composeFile).toContain('docker-compose.prod.yml');
  });

  it('dev mode flips scheme, suffix, projectsDir and compose file', async () => {
    process.env.CONSOLE_MODE = 'dev';
    const cfg = await loadConfig();
    expect(cfg.mode).toBe('dev');
    expect(cfg.scheme).toBe('http');
    expect(cfg.domainSuffix).toBe('localhost');
    expect(cfg.projectsDir).toContain('.dev-projects');
    expect(cfg.composeFile).toContain('docker-compose.dev-multi.yml');
  });

  it('explicit env vars override dev defaults', async () => {
    process.env.CONSOLE_MODE = 'dev';
    process.env.PROJECTS_DIR = '/tmp/custom';
    process.env.COMPOSE_FILE = '/tmp/custom-compose.yml';
    const cfg = await loadConfig();
    expect(cfg.projectsDir).toBe('/tmp/custom');
    expect(cfg.composeFile).toContain('custom-compose.yml');
  });

  it('treats an unknown CONSOLE_MODE as prod', async () => {
    process.env.CONSOLE_MODE = 'staging';
    const cfg = await loadConfig();
    expect(cfg.mode).toBe('prod');
    expect(cfg.scheme).toBe('https');
  });
});
