import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';

const root = path.resolve(__dirname, '../../..');
const { validateReleaseEnv, isSmokeConfigured, SMOKE_REQUIRED } = require('../../../deploy/validate-release-env.cjs');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const bashPath = (value: string) => value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
const temporary: string[] = [];
const makeTemp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'motherbase-release-test-'));
  temporary.push(dir);
  return dir;
};
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const configured = {
  VPS_HOST: 'vps.example.com', VPS_SSH_KEY: 'private-key', VPS_KNOWN_HOSTS: 'verified-host-key',
  VPS_USER: 'motherbase', VPS_SSH_PORT: '22', VPS_REMOTE_DIR: 'motherbase',
  GITHUB_SHA: 'a'.repeat(40), GITHUB_REF_NAME: 'v1.2.3', CONSOLE_URL: 'https://console.example.com',
  ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'never-print-me', PROJECT: 'release-smoke',
  PROJECT_URL: 'https://release-smoke.example.com', PROJECT_EMAIL: 'smoke@example.com',
  PROJECT_PASSWORD: 'another-secret', RLS_MODEL: 'smoke_rows', PRIVATE_EDGE_ROUTE: 'smoke',
};

describe('production preflight', () => {
  it('accepts a complete configuration and requires every credential and fixture', () => {
    expect(validateReleaseEnv(configured)).toEqual([]);
    for (const key of Object.keys(configured)) {
      expect(validateReleaseEnv({ ...configured, [key]: '' })).toContain(`${key} is required`);
    }
  });
  it.each([
    ['CONSOLE_URL', 'http://console.example.com'], ['PROJECT_URL', 'https://user:pass@example.com'],
    ['PROJECT_URL', 'https://example.com/path'], ['PROJECT_URL', 'https://example.com/?token=secret'],
    ['VPS_USER', 'root'], ['VPS_SSH_PORT', '65536'], ['VPS_REMOTE_DIR', "repo'; touch pwned"],
    ['VPS_REMOTE_DIR', '../repo'], ['VPS_HOST', 'host;id'], ['GITHUB_SHA', 'master'],
    ['GITHUB_REF_NAME', 'feature'], ['GITHUB_REF_NAME', 'master'], ['GITHUB_REF_NAME', 'v1.2'], ['RLS_MODEL', 'rows?select=*'], ['PRIVATE_EDGE_ROUTE', '../admin'],
  ])('rejects invalid %s without leaking values', (key, value) => {
    const errors = validateReleaseEnv({ ...configured, [key]: value });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((error: string) => error.startsWith(key))).toBe(true);
    expect(errors.join()).not.toContain(configured.ADMIN_PASSWORD);
  });
  it('requires the smoke configuration only once any of it is set', () => {
    // An installation with no smoke project yet must still be able to ship: the
    // deploy credentials are what make a deploy possible, the smoke values only
    // describe what to check afterwards.
    const withoutSmoke = { ...configured };
    for (const key of SMOKE_REQUIRED) delete withoutSmoke[key as keyof typeof configured];
    expect(validateReleaseEnv(withoutSmoke)).toEqual([]);
    expect(isSmokeConfigured(withoutSmoke)).toBe(false);

    // Half a smoke configuration is worse than none: it would pass by skipping
    // the checks it cannot make, so setting one value demands the rest.
    const partial = { ...withoutSmoke, CONSOLE_URL: 'https://console.example.com' };
    const errors = validateReleaseEnv(partial);
    expect(isSmokeConfigured(partial)).toBe(true);
    expect(errors).toContain('PROJECT is required');
    expect(errors).not.toContain('CONSOLE_URL is required');
    expect(errors.every((error: string) => SMOKE_REQUIRED.some((key: string) => error.startsWith(key)))).toBe(true);
  });

  it('wires both CI gates, and runs the post-deploy checks only when configured', () => {
    const workflow = load(readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')) as any;
    const deploy = workflow.jobs['deploy-vps'];
    expect(deploy.needs).toEqual(expect.arrayContaining(['ci', 'runtime']));
    // Production moves on a release tag, never on a push to master.
    expect(deploy.if).toBe("startsWith(github.ref, 'refs/tags/v')");

    const stepFor = (script: string) => deploy.steps.find((s: any) => s.run?.includes(script));

    // The preflight and the deploy itself are never conditional.
    const preflight = stepFor('validate-release-env.cjs');
    expect(preflight).toBeDefined();
    expect(preflight.if).toBeUndefined();
    expect(preflight.id).toBe('preflight');
    expect(stepFor('deploy-release.sh').if).toBeUndefined();

    // The smoke steps hang off the preflight's own answer, so they cannot run
    // against a configuration the validator has not checked.
    for (const script of ['vps-smoke.sh', 'critical-flows-smoke.sh']) {
      const step = stepFor(script);
      expect(step).toBeDefined();
      expect(step.if).toBe("steps.preflight.outputs.smoke == 'true'");
    }
  });

  it('publishes a release only from a checked tag', () => {
    const workflow = load(readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')) as any;
    const steps: any[] = workflow.jobs.runtime.steps;
    const index = (name: string) => steps.findIndex(step => step.name === name);
    const onTag = "startsWith(github.ref, 'refs/tags/v')";

    // The tag is checked against package.json and CHANGELOG.md before anything
    // is built, and every release step is gated on a tag.
    expect(index('Check the release tag')).toBeLessThan(index('Build runtime images'));
    for (const name of ['Check the release tag', 'Build the install bundle', "Attest the bundle's build provenance", 'Publish the release']) {
      expect(steps[index(name)]?.if, name).toBe(onTag);
    }
    // Bundle and digest go up in the one call that creates the release.
    expect(steps[index('Publish the release')].run).toMatch(/motherbase-deploy\.tar\.gz motherbase-deploy\.tar\.gz\.sha256/);
  });
});

function runGit(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message);
  return result.stdout.trim();
}

function releaseFixture() {
  const dir = makeTemp();
  const origin = path.join(dir, 'origin');
  const checkout = path.join(dir, 'checkout');
  const probe = path.join(dir, 'deployed-sha');
  mkdirSync(origin);
  runGit(origin, 'init', '-b', 'master');
  writeFileSync(path.join(origin, '.gitignore'), '.env\n');
  writeFileSync(path.join(origin, 'setup.sh'), '#!/usr/bin/env bash\nset -e\ngit rev-parse HEAD > "$DEPLOY_PROBE"\n');
  runGit(origin, 'add', '.');
  const commit = () => {
    runGit(origin, '-c', 'user.name=Release test', '-c', 'user.email=test@example.com', 'commit', '-am', 'fixture');
    return runGit(origin, 'rev-parse', 'HEAD');
  };
  const sha = commit();
  runGit(origin, 'tag', 'v1.0.0');
  runGit(dir, '-c', 'core.autocrlf=false', 'clone', origin, checkout);
  writeFileSync(path.join(checkout, '.env'), 'fixture=true\n');
  const deploy = () => spawnSync(bash, ['-c',
    // Git Bash lacks flock; Linux CI runs the real lock. Everything else uses
    // real Git repositories on both platforms, never the developer checkout.
    `${process.platform === 'win32' ? 'flock() { return 0; }; export -f flock; ' : ''}bash "$1" "$2" "$3" "$4"`,
    '--', bashPath(path.join(root, 'deploy/deploy-release.sh')), bashPath(checkout), sha, 'v1.0.0'], {
    env: { ...process.env, DEPLOY_PROBE: bashPath(probe) }, encoding: 'utf8', windowsHide: true,
  });
  return { origin, checkout, probe, sha, commit, deploy };
}

describe('release checkout', () => {
  it('executes setup at the tested SHA and keeps installation configuration', () => {
    const fixture = releaseFixture();
    const result = fixture.deploy();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(fixture.probe, 'utf8').trim()).toBe(fixture.sha);
    expect(readFileSync(path.join(fixture.checkout, '.env'), 'utf8')).toBe('fixture=true\n');
  });
  it('deploys a release, never a push to master', () => {
    const fixture = releaseFixture();
    writeFileSync(path.join(fixture.origin, 'setup.sh'), 'exit 99\n');
    fixture.commit();
    const result = fixture.deploy();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(fixture.probe, 'utf8').trim()).toBe(fixture.sha);
  });
  it('refuses a stale job once a newer release is tagged', () => {
    const fixture = releaseFixture();
    writeFileSync(path.join(fixture.origin, 'setup.sh'), 'exit 99\n');
    fixture.commit();
    runGit(fixture.origin, 'tag', 'v1.0.1');
    const result = fixture.deploy();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Release superseded');
    expect(existsSync(fixture.probe)).toBe(false);
    expect(runGit(fixture.checkout, 'rev-parse', 'HEAD')).toBe(fixture.sha);
  });
  it('preserves local edits and never executes setup on a dirty checkout', () => {
    const fixture = releaseFixture();
    writeFileSync(path.join(fixture.checkout, 'setup.sh'), 'local changes\n');
    const result = fixture.deploy();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('local changes');
    expect(existsSync(fixture.probe)).toBe(false);
    expect(readFileSync(path.join(fixture.checkout, 'setup.sh'), 'utf8')).toBe('local changes\n');
  });
});

describe('smoke HTTP transport', () => {
  it('ignores insecure legacy options and preserves a CA path with spaces', () => {
    const result = spawnSync(bash, ['-c',
      'source "$1"; curl() { printf "%s\\n" "$@"; }; smoke_http https://example.com',
      '--', path.join(root, 'apps/server/tests/smoke-http.sh').replaceAll('\\', '/')], {
      env: { ...process.env, CURL_OPTS: '-k', SMOKE_CA_CERT: '/tmp/test CA.pem' },
      encoding: 'utf8', windowsHide: true,
    });
    expect(result.status, result.stderr).toBe(0);
    const args = result.stdout.trim().split(/\r?\n/);
    expect(args[0]).toBe('--disable');
    expect(args).toEqual(expect.arrayContaining(['--connect-timeout', '10', '--max-time', '30', '--cacert', '/tmp/test CA.pem']));
    expect(args).not.toContain('-k');
    expect(args).not.toContain('--insecure');
  });
});
