import { describe, it, expect } from 'vitest';
import { rlsContextFor } from '../lib/rls-claims';

describe('rlsContextFor', () => {
  it('returns anon with empty sub when no user', () => {
    const ctx = rlsContextFor(undefined);
    expect(ctx.role).toBe('anon');
    expect(JSON.parse(ctx.claims)).toEqual({ role: 'anon' });
  });

  it('returns authenticated with sub + email + user_role', () => {
    const ctx = rlsContextFor({ id: 'u1', role: 'ADMIN', email: 'a@test.dev' });
    expect(ctx.role).toBe('authenticated');
    expect(JSON.parse(ctx.claims)).toEqual({
      sub: 'u1', role: 'authenticated', email: 'a@test.dev', user_role: 'ADMIN', is_anonymous: false,
    });
  });

  // Supabase policies gate guests with `(auth.jwt()->>'is_anonymous')::boolean`.
  it('flags an anonymous caller in the is_anonymous claim', () => {
    const ctx = rlsContextFor({ id: 'u1', role: 'USER', isAnonymous: true });
    expect(ctx.role).toBe('authenticated');
    expect(JSON.parse(ctx.claims).is_anonymous).toBe(true);
  });

  // auth.email() reads this claim; it must be present-and-null rather than
  // absent so a policy comparing against it fails closed instead of erroring.
  it('emits a null email claim when the caller has none', () => {
    const ctx = rlsContextFor({ id: 'u1', role: 'USER' });
    expect(JSON.parse(ctx.claims).email).toBeNull();
  });

  it('treats a user without id as anon', () => {
    const ctx = rlsContextFor({ role: 'USER' } as any);
    expect(ctx.role).toBe('anon');
  });
});
