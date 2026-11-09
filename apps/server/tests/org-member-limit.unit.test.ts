import { describe, expect, it } from 'vitest';
import { orgFullMessage, orgHasRoomForMember, orgSeatLimit } from '../auth/org-limits';
import { getGroup } from '../config/settings';

// The seat cap is enforced by Better Auth in three places (add member, accept
// invitation, and (through the SSO provisioning hook) auto-provisioning), all
// of which ask the same two functions. This covers under / at / over the limit
// and the unlimited default, which is the whole branch surface.

describe('organization seat limit', () => {
  it('treats 0, absent and invalid as unlimited', () => {
    for (const value of [0, undefined, null, '', 'abc', -3]) {
      expect(orgSeatLimit(value)).toBe(Infinity);
      expect(orgHasRoomForMember(10_000, value)).toBe(true);
    }
  });

  it('allows under the limit, refuses at and over it', () => {
    expect(orgHasRoomForMember(2, 3)).toBe(true);
    expect(orgHasRoomForMember(3, 3)).toBe(false);
    expect(orgHasRoomForMember(4, 3)).toBe(false);
  });

  it('accepts the string a settings row can hold', () => {
    expect(orgSeatLimit('3')).toBe(3);
    expect(orgHasRoomForMember(3, '3')).toBe(false);
  });

  it('names the limit in the refusal', () => {
    expect(orgFullMessage(3)).toContain('maximum of 3 members');
    expect(orgFullMessage(1)).toContain('maximum of 1 member');
  });
});

describe('auth.organization settings group', () => {
  const group = getGroup('auth.organization')!;

  it('defaults maxMembers to unlimited so existing installs are unaffected', () => {
    const parsed = group.schema.parse({}) as Record<string, unknown>;
    expect(parsed.maxMembers).toBe(0);
    expect(orgSeatLimit(parsed.maxMembers)).toBe(Infinity);
  });

  it('exposes the limit and the renamed teams flag as console fields', () => {
    const keys = group.fields.map(f => f.key);
    expect(keys).toContain('maxMembers');
    expect(keys).toContain('teamsEnabled');
    // The old name claimed to control SSO and never did.
    expect(keys).not.toContain('allowOrgSso');
  });

  it('rejects a negative or fractional limit', () => {
    expect(group.schema.safeParse({ maxMembers: -1 }).success).toBe(false);
    expect(group.schema.safeParse({ maxMembers: 2.5 }).success).toBe(false);
  });

  it('keeps SSO governed by auth.sso alone', () => {
    const sso = getGroup('auth.sso')!;
    expect(sso.fields.map(f => f.key)).toEqual(['enabled']);
    expect(group.fields.some(f => /sso/i.test(f.key))).toBe(false);
    expect(sso.description).toMatch(/single switch/i);
  });
});
