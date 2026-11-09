import { describe, it, expect } from 'vitest';
import { buildTableMetadata } from '../services/admin/admin.service';

describe('table metadata', () => {
  const tables = buildTableMetadata();

  it('includes the User model with its db name', () => {
    const user = tables.find(t => t.model === 'User');
    expect(user).toBeTruthy();
    expect(user!.dbName).toBe('users');
  });

  it('marks the id field as the primary key', () => {
    const user = tables.find(t => t.model === 'User')!;
    const id = user.fields.find(f => f.name === 'id')!;
    expect(id.isId).toBe(true);
  });

  it('flags sensitive fields so the UI can hide them', () => {
    // Passwords live on the Better Auth Account table (Account.password).
    const account = tables.find(t => t.model === 'Account')!;
    const pw = account.fields.find(f => f.name === 'password')!;
    expect(pw.sensitive).toBe(true);
  });

  it('exposes a lower-camel delegate key for Prisma access', () => {
    const user = tables.find(t => t.model === 'User')!;
    expect(user.delegate).toBe('user');
  });
});
