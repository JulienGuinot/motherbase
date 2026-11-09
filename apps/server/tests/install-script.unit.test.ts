import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// install.sh is what `curl -fsSL <site>/install.sh | bash` runs as root on a
// fresh VPS. These run the real script against a bundle served from disk.
const installScript = path.resolve(__dirname, '../../../install.sh');

let work: string;
let bundle: string;
let installDir: string;

function makeBundle() {
  const src = path.join(work, 'src');
  fs.mkdirSync(src);
  // Stands in for the real setup.sh: records how it was called.
  fs.writeFileSync(path.join(src, 'setup.sh'), '#!/usr/bin/env bash\necho "$@" > setup-args\n', { mode: 0o755 });
  bundle = path.join(work, 'bundle.tar.gz');
  spawnSync('tar', ['czf', bundle, '-C', src, 'setup.sh']);
}

function writeDigest(digest: string) {
  fs.writeFileSync(`${bundle}.sha256`, `${digest}\n`);
}

function install(...args: string[]) {
  return spawnSync('bash', [installScript, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MOTHERBASE_DIR: installDir, MOTHERBASE_BUNDLE_URL: `file://${bundle}` },
  });
}

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-install-'));
  installDir = path.join(work, 'motherbase');
  makeBundle();
});

afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

describe('install.sh', () => {
  it('unpacks a verified bundle and runs setup.sh in VPS mode with the caller arguments', () => {
    writeDigest(createHash('sha256').update(fs.readFileSync(bundle)).digest('hex'));

    const result = install('--yes', '--skip-dns-check');

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(installDir, 'setup-args'), 'utf8').trim()).toBe('--prod --yes --skip-dns-check');
  });

  it('refuses a bundle whose digest does not match, before unpacking anything', () => {
    writeDigest('0'.repeat(64));

    const result = install('--yes');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('checksum mismatch');
    expect(fs.existsSync(path.join(installDir, 'setup.sh'))).toBe(false);
  });

  it('refuses to reinstall over an existing install and points at update.sh', () => {
    writeDigest(createHash('sha256').update(fs.readFileSync(bundle)).digest('hex'));
    fs.mkdirSync(installDir);
    fs.writeFileSync(path.join(installDir, '.env'), 'POSTGRES_PASSWORD=keep-me\n');

    const result = install('--yes');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('./deploy/update.sh');
    expect(fs.readFileSync(path.join(installDir, '.env'), 'utf8')).toContain('keep-me');
  });
});
