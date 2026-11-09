import { describe, it, expect } from 'vitest';
import { SENSITIVE_FIELDS, isSensitiveField, maskRow } from '../constants/admin.constants';

describe('sensitive field masking', () => {
  it('lists known secret columns', () => {
    expect(SENSITIVE_FIELDS).toContain('passwordHash');
    expect(SENSITIVE_FIELDS).toContain('tokenHash');
    expect(SENSITIVE_FIELDS).toContain('secretCode');
  });

  it('flags sensitive fields case-sensitively by exact name', () => {
    expect(isSensitiveField('passwordHash')).toBe(true);
    expect(isSensitiveField('email')).toBe(false);
  });

  it('removes sensitive keys from a row without mutating the input', () => {
    const row = { id: '1', email: 'a@b.c', passwordHash: 'secret', tokenHash: 'x' };
    const masked = maskRow(row);
    expect(masked).toEqual({ id: '1', email: 'a@b.c' });
    expect(row.passwordHash).toBe('secret'); // original untouched
  });

  it('returns null/undefined rows unchanged', () => {
    expect(maskRow(null)).toBeNull();
    expect(maskRow(undefined)).toBeUndefined();
  });
});
