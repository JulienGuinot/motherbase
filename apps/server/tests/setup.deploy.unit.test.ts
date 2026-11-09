import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

const setupScript = fs.readFileSync(path.resolve(__dirname, '../../../setup.sh'), 'utf8');

/** Runs one setup.sh function against a fake `docker` and returns the docker calls it made. */
function dockerCallsOf(fn: string, images: string[]): string[] {
  const body = setupScript.match(new RegExp(`^${fn}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0];
  if (!body) throw new Error(`${fn} not found in setup.sh`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-setup-'));
  const log = path.join(work, 'docker.log');
  fs.writeFileSync(path.join(work, 'docker'), [
    '#!/usr/bin/env bash',
    `echo "$*" >> "${log.replace(/\\/g, '/')}"`,
    `[ "$1" = images ] && printf '%s\\n' ${images.join(' ')}`,
    'exit 0',
  ].join('\n'), { mode: 0o755 });
  const script = `step(){ :; }; ok(){ :; }; warn(){ :; }\nMOTHERBASE_REGISTRY=ghcr.io/owner\n${body}\n${fn}\n`;
  spawnSync('bash', ['-c', script], { env: { ...process.env, PATH: `${work}${path.delimiter}${process.env.PATH}` } });
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
}

describe('superseded image cleanup', () => {
  // A pulled image was tagged twice and only the local tag ever moved, so every
  // old release stayed tagged and `docker image prune` (dangling only) kept it.
  it('untags leftover registry sha tags before pruning, and nothing else', () => {
    const calls = dockerCallsOf('prune_superseeded_images', [
      'ghcr.io/owner/motherbase-api:sha-old',
      'ghcr.io/owner/motherbase-edge-runtime:sha-old',
      'motherbase-api:1.0.0',
      'ghcr.io/other/motherbase-api:sha-old',
      'postgres:16',
    ]);
    const rmi = calls.find(call => call.startsWith('rmi'));
    expect(rmi).toBe('rmi ghcr.io/owner/motherbase-api:sha-old ghcr.io/owner/motherbase-edge-runtime:sha-old');
    expect(calls.indexOf(rmi!)).toBeLessThan(calls.indexOf('image prune -f'));
  });

  it('drops the registry tag of each image it pulls', () => {
    expect(setupScript).toContain('docker rmi "$MOTHERBASE_REGISTRY/motherbase-$name:sha-$sha"');
  });
});

describe('VPS project API deployment', () => {
  it('recreates and health-checks running project APIs after rebuilding images', () => {
    expect(setupScript).toContain('reconcile_running_vps_projects()');
    expect(setupScript).toContain('--filter "label=com.docker.compose.project=$project"');
    expect(setupScript).toContain('--filter "label=com.docker.compose.service=api"');
    expect(setupScript).toContain('up -d --force-recreate --no-deps edge-runtime api');
    expect(setupScript).toContain('Project $project API not healthy after 120s');

    const startVpsIndex = setupScript.indexOf('start_vps()');
    const buildIndex = setupScript.indexOf('  build_images', startVpsIndex);
    const reconcileIndex = setupScript.indexOf('  reconcile_running_vps_projects', buildIndex);

    expect(startVpsIndex).toBeGreaterThan(-1);
    expect(buildIndex).toBeGreaterThan(startVpsIndex);
    expect(reconcileIndex).toBeGreaterThan(buildIndex);
  });
});
