import dns from 'dns';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticsService } from '../console/services/diagnostics.service';

describe('DiagnosticsService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats localhost project domains as valid in dev mode', async () => {
    const service = new DiagnosticsService({ mode: 'dev', domainSuffix: 'localhost' });

    const checks = await service.projectDns({
      name: 'foo',
      domain: 'foo.localhost',
      storageDomain: 'storage.foo.localhost',
    });

    expect(checks).toHaveLength(3);
    expect(checks.every(c => c.ok)).toBe(true);
    expect(checks[0].message).toMatch(/localhost/i);
  });

  it('checks wildcard project DNS instead of requiring an apex record in prod', async () => {
    const lookup = vi
      .spyOn(dns.promises, 'lookup')
      .mockResolvedValue([{ address: '203.0.113.10', family: 4 }] as any);
    const service = new DiagnosticsService({ mode: 'prod', domainSuffix: 'example.com' });

    const checks = await service.consoleDns('console.example.com');

    expect(checks.map(c => c.name)).toEqual(['console host', 'wildcard project DNS']);
    expect(lookup).toHaveBeenNthCalledWith(1, 'console.example.com', { all: true });
    expect(lookup).toHaveBeenNthCalledWith(2, 'motherbase-check.example.com', { all: true });
    expect(checks.every(c => c.ok)).toBe(true);
  });
});
