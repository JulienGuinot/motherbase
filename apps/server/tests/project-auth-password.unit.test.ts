import { describe, it, expect } from 'vitest';
import argon2 from 'argon2';
import bcrypt from 'bcryptjs';
import { hashPassword, verifyPassword } from '../auth/password';

describe('project auth password hooks', () => {
  it('hashes with argon2 and verifies its own hash', async () => {
    const h = await hashPassword('hunter2');
    expect(h.startsWith('$argon2')).toBe(true);
    expect(await verifyPassword({ password: 'hunter2', hash: h })).toBe(true);
    expect(await verifyPassword({ password: 'wrong', hash: h })).toBe(false);
  });

  it('verifies a legacy bcrypt hash (Supabase import compat)', async () => {
    const legacy = bcrypt.hashSync('s3cret', 10);
    expect(await verifyPassword({ password: 's3cret', hash: legacy })).toBe(true);
    expect(await verifyPassword({ password: 'nope', hash: legacy })).toBe(false);
  });

  it('accepts a raw argon2 hash produced elsewhere', async () => {
    const h = await argon2.hash('external');
    expect(await verifyPassword({ password: 'external', hash: h })).toBe(true);
  });

  it('returns false for an empty or malformed hash without throwing', async () => {
    expect(await verifyPassword({ password: 'x', hash: '' })).toBe(false);
    expect(await verifyPassword({ password: 'x', hash: 'not-a-hash' })).toBe(false);
  });
});
