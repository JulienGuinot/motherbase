import { describe, expect, it } from 'vitest';
import { canonicalCidr, networkRestrictionsSchema, renderPgHba } from '../services/admin/database-access';

describe('canonicalCidr', () => {
  it('masks host bits off, the way Postgres requires', () => {
    expect(canonicalCidr('10.1.2.3/8', 4)).toBe('10.0.0.0/8');
    expect(canonicalCidr('203.0.113.7', 4)).toBe('203.0.113.7/32');
    expect(canonicalCidr('2001:db8::1/32', 6)).toBe('2001:db8::/32');
    expect(canonicalCidr('::ffff:10.0.0.1/128', 6)).toBe('::ffff:a00:1/128');
    expect(canonicalCidr('::/0', 6)).toBe('::/0');
  });

  it('rejects the wrong family, bad masks and garbage', () => {
    expect(canonicalCidr('10.0.0.0/8', 6)).toBeNull();
    expect(canonicalCidr('::/0', 4)).toBeNull();
    expect(canonicalCidr('10.0.0.0/33', 4)).toBeNull();
    expect(canonicalCidr('10.0.0.0/8/1', 4)).toBeNull();
    expect(canonicalCidr('10.0.0.0/+8', 4)).toBeNull();
    expect(canonicalCidr('samenet', 4)).toBeNull();
  });
});

describe('networkRestrictionsSchema', () => {
  it('canonicalises and de-duplicates, and names every bad entry', () => {
    expect(networkRestrictionsSchema.parse({ dbAllowedCidrs: ['10.0.0.1/8', '10.0.0.0/8'] })).toEqual({
      dbAllowedCidrs: ['10.0.0.0/8'],
    });
    const result = networkRestrictionsSchema.safeParse({ dbAllowedCidrs: ['nope'], dbAllowedCidrsV6: ['1.2.3.4/32'] });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map(i => i.message)).toEqual([
      'nope is not a valid IPv4 CIDR',
      '1.2.3.4/32 is not a valid IPv6 CIDR',
    ]);
  });
});

describe('renderPgHba', () => {
  const lines = (text: string) => text.split('\n').filter(line => line && !line.startsWith('#'));

  it('always keeps the stack able to reach its own database', () => {
    for (const sslEnforced of [false, true]) {
      const hba = renderPgHba({ dbAllowedCidrs: [], dbAllowedCidrsV6: [], sslEnforced });
      expect(lines(hba)).toEqual([
        'local   all  all  trust',
        'local   replication  all  trust',
        expect.stringMatching(/^host\s+all\s+all\s+127\.0\.0\.1\/32\s+scram-sha-256$/),
        expect.stringMatching(/^host\s+all\s+all\s+::1\/128\s+scram-sha-256$/),
        expect.stringMatching(/^host\s+all\s+all\s+samenet\s+scram-sha-256$/),
      ]);
    }
  });

  it('allows only the listed ranges from outside, over TLS when enforced', () => {
    const open = lines(renderPgHba({ dbAllowedCidrs: ['203.0.113.0/24'], dbAllowedCidrsV6: ['2001:db8::/32'], sslEnforced: false }));
    expect(open.slice(5)).toEqual([
      expect.stringMatching(/^host\s+all\s+all\s+203\.0\.113\.0\/24\s+scram-sha-256$/),
      expect.stringMatching(/^host\s+all\s+all\s+2001:db8::\/32\s+scram-sha-256$/),
    ]);
    const tls = lines(renderPgHba({ dbAllowedCidrs: ['203.0.113.0/24'], dbAllowedCidrsV6: [], sslEnforced: true }));
    expect(tls.slice(5)).toEqual([expect.stringMatching(/^hostssl\s+all\s+all\s+203\.0\.113\.0\/24\s+scram-sha-256$/)]);
  });
});
