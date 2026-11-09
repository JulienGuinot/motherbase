import { describe, it, expect } from 'vitest';
import {
  buildManifest,
  renderEnvProd,
  parseLimits,
  DEFAULT_LIMITS,
  type CreateProjectInput,
} from '../console/lib/manifest';

const input: CreateProjectInput = {
  name: 'projet-a',
  domain: 'projet-a.example.com',
  storageDomain: 'projet-a-storage.example.com',
  corsOrigins: 'https://app.example.com',
};
const fixedSecret = (n: number) => 'x'.repeat(n);

describe('buildManifest', () => {
  it('produces a manifest with name, domains and a generated platform token', () => {
    const m = buildManifest(input, fixedSecret);
    expect(m.name).toBe('projet-a');
    expect(m.domain).toBe('projet-a.example.com');
    expect(m.storageDomain).toBe('projet-a-storage.example.com');
    expect(m.platformServiceToken.length).toBeGreaterThan(0);
    expect(m.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects invalid names', () => {
    expect(() => buildManifest({ ...input, name: 'Bad Name' }, fixedSecret)).toThrow(/invalid project name/i);
  });

  it.each([
    ['domain line breaks', { domain: 'api.example.com\nAPI_IMAGE=evil' }],
    ['invalid storage hostname', { storageDomain: 'https://storage.example.com' }],
    ['CORS paths', { corsOrigins: 'https://app.example.com/private' }],
    ['invalid image reference', { apiImage: 'image name:latest' }],
  ])('rejects unsafe project config: %s', (_label, patch) => {
    expect(() => buildManifest({ ...input, ...patch }, fixedSecret)).toThrow();
  });
});

describe('renderEnvProd', () => {
  it('renders an .env.prod containing all required secrets and the token', () => {
    const m = buildManifest(input, fixedSecret);
    const env = renderEnvProd(m);
    for (const key of [
      'COMPOSE_PROJECT_NAME=projet-a',
      'PROJECT_DOMAIN=projet-a.example.com',
      'API_IMAGE=motherbase-api:1.0.0',
      'JWT_SECRET=',
      'POSTGRES_PASSWORD=',
      'CONFIG_ENCRYPTION_KEY=',
      'PLATFORM_SERVICE_TOKEN=',
    ]) {
      expect(env).toContain(key);
    }
  });

  it('renders the project-specific API image', () => {
    const env = renderEnvProd(buildManifest({ ...input, apiImage: 'ghcr.io/acme/api:2.0.0' }, fixedSecret));
    expect(env).toContain('API_IMAGE=ghcr.io/acme/api:2.0.0');
  });
});

describe('resource limits', () => {
  it('buildManifest applies the Small-tier defaults when no override is given', () => {
    const m = buildManifest(input, fixedSecret);
    expect(m.limits).toEqual(DEFAULT_LIMITS);
  });

  it('buildManifest honours partial caller overrides, keeping defaults for the rest', () => {
    const m = buildManifest({ ...input, limits: { apiCpus: 2, dbMemMb: 1024 } }, fixedSecret);
    expect(m.limits.apiCpus).toBe(2);
    expect(m.limits.dbMemMb).toBe(1024);
    expect(m.limits.minioCpus).toBe(DEFAULT_LIMITS.minioCpus); // untouched
  });

  it('renderEnvProd emits the limit vars with cpu/mem/disk formatting', () => {
    const m = buildManifest({ ...input, limits: { apiCpus: 1.5, apiMemMb: 1024 } }, fixedSecret);
    const env = renderEnvProd(m);
    expect(env).toContain('API_CPUS=1.5');
    expect(env).toContain('API_MEM=1024M');
    expect(env).toContain('DB_CPUS=0.5');
    expect(env).toContain('DB_MEM=512M');
    expect(env).toContain('MINIO_CPUS=0.25');
    expect(env).toContain('MINIO_MEM=256M');
    expect(env).toContain('EDGE_RUNTIME_CPUS=0.5');
    expect(env).toContain('EDGE_RUNTIME_MEM=768M');
    expect(env).toContain('DISK_GB=10');
  });

  it('parseLimits round-trips the vars renderEnvProd wrote', () => {
    const m = buildManifest({ ...input, limits: { apiCpus: 3, minioMemMb: 512 } }, fixedSecret);
    expect(parseLimits(renderEnvProd(m))).toEqual(m.limits);
  });

  it('parseLimits falls back to defaults for absent vars', () => {
    expect(parseLimits('FOO=bar\n')).toEqual(DEFAULT_LIMITS);
  });
});

describe('buildManifest dev mode', () => {
  it('auto-derives <name>.localhost domains and http CORS when domain omitted and suffix set', () => {
    const m = buildManifest({ name: 'foo' }, fixedSecret, { scheme: 'http', domainSuffix: 'localhost' });
    expect(m.domain).toBe('foo.localhost');
    expect(m.storageDomain).toBe('foo-storage.localhost');
    expect(m.minioConsoleDomain).toBe('foo-minio.localhost');
    expect(m.corsOrigins).toBe('http://foo.localhost');
  });

  it('defaults to https CORS when scheme omitted but suffix set', () => {
    const m = buildManifest({ name: 'foo' }, fixedSecret, { domainSuffix: 'localhost' });
    expect(m.corsOrigins).toBe('https://foo.localhost');
  });

  it('still throws when domain missing and no suffix (prod)', () => {
    expect(() => buildManifest({ name: 'foo' }, fixedSecret)).toThrow(/domain is required/i);
  });

  it('honours an explicit domain even when a suffix is set', () => {
    const m = buildManifest({ name: 'foo', domain: 'custom.localhost' }, fixedSecret, {
      scheme: 'http',
      domainSuffix: 'localhost',
    });
    expect(m.domain).toBe('custom.localhost');
  });
});
