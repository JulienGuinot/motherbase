import { describe, it, expect } from 'vitest';
import { buildClaims, parseFieldList, type AccessTokenConfig } from '../auth/hooks/access-token';

const base: AccessTokenConfig = { enabled: true, includeUserFields: [], staticClaims: {} };
const user = { id: 'u1', role: 'ADMIN', status: 'active', password: 'secret', twoFactorEnabled: true };

describe('access-token hook', () => {
  it('returns no claims when disabled', () => {
    expect(buildClaims({ ...base, enabled: false, includeUserFields: ['role'] }, user)).toEqual({});
  });

  it('copies whitelisted user fields, skipping blocked and missing ones', () => {
    const claims = buildClaims({ ...base, includeUserFields: ['role', 'status', 'password', 'missing'] }, user);
    expect(claims).toEqual({ role: 'ADMIN', status: 'active' });
    expect(claims.password).toBeUndefined();
  });

  it('merges static claims but never overrides reserved JWT claims', () => {
    const claims = buildClaims({ ...base, staticClaims: { tenant: 'acme', sub: 'hacker', aud: 'x' } }, user);
    expect(claims.tenant).toBe('acme');
    expect(claims.sub).toBeUndefined();
    expect(claims.aud).toBeUndefined();
  });

  it('user fields and static claims combine', () => {
    const claims = buildClaims({ ...base, includeUserFields: ['role'], staticClaims: { plan: 'pro' } }, user);
    expect(claims).toEqual({ role: 'ADMIN', plan: 'pro' });
  });

  it('parseFieldList splits and trims', () => {
    expect(parseFieldList('role, status  username')).toEqual(['role', 'status', 'username']);
    expect(parseFieldList('')).toEqual([]);
  });
});
