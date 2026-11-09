import { describe, it, expect } from 'vitest';
import bcrypt from 'bcryptjs';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../console/auth/password';

describe('console password', () => {
  it('verifies a legacy bcrypt hash from the JSON store', async () => {
    const legacy = bcrypt.hashSync('s3cret', 10);
    expect(await verifyPassword({ password: 's3cret', hash: legacy })).toBe(true);
    expect(await verifyPassword({ password: 'wrong', hash: legacy })).toBe(false);
  });

  it('produces a bcrypt hash it can verify', async () => {
    const h = await hashPassword('hunter2');
    expect(h).toMatch(/^\$2[aby]\$/);
    expect(await verifyPassword({ password: 'hunter2', hash: h })).toBe(true);
  });

  it('returns false for empty hash without throwing', async () => {
    expect(await verifyPassword({ password: 'x', hash: '' })).toBe(false);
  });

  it('spends a real bcrypt round for a login with no account', async () => {
    const started = Date.now();
    await burnPasswordCheck('whatever');
    // A skipped hash returns in well under a millisecond; cost-10 bcrypt does not.
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
  });
});
