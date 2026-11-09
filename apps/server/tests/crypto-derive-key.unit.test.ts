import crypto from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveKey } from '../helpers/crypto.helper';

const original = process.env.CONFIG_ENCRYPTION_KEY;
afterEach(() => {
  if (original === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
  else process.env.CONFIG_ENCRYPTION_KEY = original;
});

describe('deriveKey', () => {
  it('returns null without a root key, or with one of the wrong length', () => {
    delete process.env.CONFIG_ENCRYPTION_KEY;
    expect(deriveKey('vault')).toBeNull();
    process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(16).toString('base64');
    expect(deriveKey('vault')).toBeNull();
  });

  it('is stable per purpose and different across purposes', () => {
    process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    const vault = deriveKey('vault');
    expect(vault).toHaveLength(32);
    expect(deriveKey('vault')!.equals(vault!)).toBe(true);
    expect(deriveKey('settings')!.equals(vault!)).toBe(false);
  });
});
