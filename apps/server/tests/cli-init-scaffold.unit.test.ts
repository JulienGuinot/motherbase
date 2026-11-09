import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// `js-yaml`, which this workspace declares (with its @types), not `yaml`:
// `yaml` resolves only because vitest's own vite pulls it and npm hoists it to
// the root node_modules, which the image build cannot rely on.
import yaml from 'js-yaml';

/** Compose documents are read for a few known keys; the shape is the test's. */
const parseYaml = (text: string) => yaml.load(text) as { services: Record<string, any> };

// `motherbase init` is the first thing a new user runs. These pin the two
// properties it cannot do without: the directory must actually start, and it
// must not ship placeholder secrets.

const local = require('../../../packages/cli/src/commands/local.js');

let dir: string;
const ctx = () => ({ cwd: dir, flags: {} });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-init-'));
  // The command prints its next steps straight to the streams; keep the suite
  // output readable.
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');

describe('motherbase init', () => {
  it('writes a compose file and a .env', async () => {
    await local.init.run(ctx(), [], {});
    expect(fs.existsSync(path.join(dir, 'docker-compose.yml'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(true);
  });

  it('emits a compose file that parses and carries the whole stack, edge runtime included', async () => {
    await local.init.run(ctx(), [], {});
    const doc = parseYaml(read('docker-compose.yml'));
    expect(Object.keys(doc.services).sort()).toEqual(['api', 'createbuckets', 'db', 'edge-runtime', 'minio']);
    // Without it `functions deploy` answered "edge runtime is not reachable".
    expect(doc.services.api.environment.EDGE_RUNTIME_URL).toBe('http://edge-runtime:9000');
  });

  it('runs the published images by default, so a clean machine needs no build', async () => {
    await local.init.run(ctx(), [], {});
    const doc = parseYaml(read('docker-compose.yml'));
    // Building from git could not work: the API image derives from
    // motherbase-deps, which nothing in the scaffold produced.
    for (const name of ['api', 'db', 'edge-runtime']) {
      expect(doc.services[name].build, name).toBeUndefined();
      expect(doc.services[name].image, name).toMatch(/motherbase-.+:\$\{MOTHERBASE_TAG:-latest\}$/);
    }
    expect(read('.env')).toMatch(/^MOTHERBASE_TAG=latest$/m);
  });

  it('still builds from source when --repo or --ref is given', async () => {
    await local.init.run(ctx(), [], { ref: 'master' });
    const doc = parseYaml(read('docker-compose.yml'));
    expect(doc.services.api.build.context).toContain('.git#master');
    expect(doc.services.db.build.dockerfile).toBe('deploy/postgres.Dockerfile');
    expect(read('docker-compose.yml')).toContain('motherbase-deps:1.0.0');
  });

  it('uses a bucket client image that needs no registry login', async () => {
    await local.init.run(ctx(), [], {});
    const doc = parseYaml(read('docker-compose.yml'));
    expect(doc.services.createbuckets.image).not.toMatch(/^quay\.io\//);
  });

  it('writes the CORS allowlist the API refuses to boot without', async () => {
    await local.init.run(ctx(), [], {});
    expect(read('.env')).toMatch(/^CORS_ORIGINS=http:\/\/localhost:3000$/m);
    expect(read('.env')).toMatch(/^CONSOLE_SQL_ENABLED=true$/m);
  });

  it('signs storage URLs for the published MinIO port, not the container address', async () => {
    await local.init.run(ctx(), [], {});
    const doc = parseYaml(read('docker-compose.yml'));
    expect(doc.services.api.environment.S3_PRESIGN_ENDPOINT).toContain('localhost');
  });

  it('binds published ports to loopback only', async () => {
    await local.init.run(ctx(), [], {});
    const doc = parseYaml(read('docker-compose.yml'));
    for (const port of [...doc.services.db.ports, ...doc.services.minio.ports]) {
      expect(String(port).startsWith('127.0.0.1:'), String(port)).toBe(true);
    }
  });

  it('generates real secrets rather than placeholders', async () => {
    await local.init.run(ctx(), [], {});
    const env = read('.env');
    expect(env).not.toMatch(/change-me/);
    const jwt = /^JWT_SECRET=(.+)$/m.exec(env)?.[1] ?? '';
    // The server rejects anything under 32 characters.
    expect(jwt.length).toBeGreaterThanOrEqual(32);
    // Base64 32 bytes, which is what CONFIG_ENCRYPTION_KEY has to be.
    const key = /^CONFIG_ENCRYPTION_KEY=(.+)$/m.exec(env)?.[1] ?? '';
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
  });

  it('gives two installs different secrets', async () => {
    await local.init.run(ctx(), [], {});
    const first = read('.env');
    fs.rmSync(path.join(dir, '.env'));
    await local.init.run(ctx(), [], {});
    expect(read('.env')).not.toBe(first);
  });

  it('never silently overwrites an existing .env', async () => {
    await local.init.run(ctx(), [], {});
    const before = read('.env');
    await local.init.run(ctx(), [], {});
    // Overwriting would discard the key existing data was encrypted with.
    expect(read('.env')).toBe(before);
  });

  it('overwrites only when asked', async () => {
    await local.init.run(ctx(), [], {});
    const before = read('.env');
    await local.init.run(ctx(), [], { force: true });
    expect(read('.env')).not.toBe(before);
  });
});

describe('motherbase start', () => {
  it('refuses a directory with no stack, and names the fix', async () => {
    await expect(local.start.run(ctx())).rejects.toThrow(/motherbase init/);
  });
});
