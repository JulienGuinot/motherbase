import { describe, expect, it } from 'vitest';
import { roleAccess, type AccessCommand, type TableAccessFacts } from '../services/admin/rls-access';
import type { PgPolicy } from '../services/admin/rls.service';

const CRUD: AccessCommand[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

function policy(overrides: Partial<PgPolicy> & Pick<PgPolicy, 'name' | 'command'>): PgPolicy {
  return { roles: ['anon'], using: null, withCheck: null, permissive: true, ...overrides };
}

function facts(policies: PgPolicy[], overrides: Partial<TableAccessFacts> = {}): TableAccessFacts {
  return { rlsEnabled: true, policies, privileges: { anon: CRUD, authenticated: CRUD }, ...overrides };
}

describe('roleAccess', () => {
  it('stops at the grant before looking at policies', () => {
    const access = roleAccess(
      facts([policy({ name: 'all', command: 'ALL', using: 'true' })], {
        privileges: { anon: ['SELECT'], authenticated: CRUD },
      }),
      'anon'
    );
    expect(access.SELECT).toEqual({ level: 'all' });
    expect(access.INSERT).toEqual({ level: 'none', blockedBy: 'grant' });
  });

  it('opens every granted command when RLS is off', () => {
    const access = roleAccess(facts([], { rlsEnabled: false }), 'anon');
    for (const command of CRUD) expect(access[command]).toEqual({ level: 'all' });
  });

  it('closes every command when RLS is on and nothing applies to the role', () => {
    const access = roleAccess(facts([policy({ name: 'own', command: 'ALL', roles: ['authenticated'], using: 'true' })]), 'anon');
    for (const command of CRUD) expect(access[command]).toEqual({ level: 'none', blockedBy: 'policy' });
  });

  it('treats a policy with no expression as letting nothing through, not as true', () => {
    const access = roleAccess(facts([policy({ name: 'bare', command: 'SELECT' })]), 'anon');
    expect(access.SELECT).toEqual({ level: 'none', blockedBy: 'policy' });
  });

  it('checks INSERT with USING when an ALL policy has no WITH CHECK', () => {
    const access = roleAccess(facts([policy({ name: 'open', command: 'ALL', using: 'true' })]), 'anon');
    expect(access.INSERT).toEqual({ level: 'all' });
  });

  it('names the policies a conditional command depends on', () => {
    const own = policy({ name: 'own', command: 'SELECT', roles: ['authenticated'], using: '(auth.uid() = owner_id)' });
    expect(roleAccess(facts([own]), 'authenticated').SELECT).toEqual({
      level: 'some',
      conditions: [
        { policy: 'own', command: 'SELECT', restrictive: false, using: '(auth.uid() = owner_id)', withCheck: null },
      ],
    });
  });

  it('lets a restrictive policy narrow an open one, and ignores one that restricts nothing', () => {
    const open = policy({ name: 'open', command: 'SELECT', using: 'true' });
    const noop = policy({ name: 'noop', command: 'SELECT', permissive: false });
    const narrow = policy({ name: 'narrow', command: 'SELECT', permissive: false, using: '(org_id = 1)' });

    expect(roleAccess(facts([open, noop]), 'anon').SELECT).toEqual({ level: 'all' });
    expect(roleAccess(facts([open, narrow]), 'anon').SELECT).toMatchObject({
      level: 'some',
      conditions: [{ policy: 'narrow', restrictive: true }],
    });
    expect(roleAccess(facts([narrow]), 'anon').SELECT).toEqual({ level: 'none', blockedBy: 'policy' });
  });

  it('bounds UPDATE and DELETE by what the role can read', () => {
    const write = policy({ name: 'write', command: 'UPDATE', using: 'true' });
    const remove = policy({ name: 'remove', command: 'DELETE', using: 'true' });
    expect(roleAccess(facts([write, remove]), 'anon')).toMatchObject({
      UPDATE: { level: 'none', blockedBy: 'read' },
      DELETE: { level: 'none', blockedBy: 'read' },
    });

    const readOwn = policy({ name: 'read_own', command: 'SELECT', using: '(auth.uid() = owner_id)' });
    expect(roleAccess(facts([write, readOwn]), 'anon').UPDATE).toMatchObject({
      level: 'some',
      conditions: [{ policy: 'read_own', command: 'SELECT' }],
    });
  });

  it('counts policies granted to PUBLIC', () => {
    const access = roleAccess(facts([policy({ name: 'everyone', command: 'SELECT', roles: ['public'], using: 'true' })]), 'anon');
    expect(access.SELECT).toEqual({ level: 'all' });
  });
});
