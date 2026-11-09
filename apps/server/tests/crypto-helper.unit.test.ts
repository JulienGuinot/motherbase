import { describe, it, expect, beforeEach } from 'vitest';
import { encryptSecret, decryptSecret, isEncryptionConfigured } from '../helpers/crypto.helper';
import crypto from 'crypto';

const KEY = crypto.randomBytes(32).toString('base64');

describe('crypto.helper', () => {
  beforeEach(() => { process.env.CONFIG_ENCRYPTION_KEY = KEY; });

  it('round-trips a secret', () => {
    const token = encryptSecret('hunter2');
    expect(token).not.toContain('hunter2');
    expect(token.startsWith('v1:')).toBe(true);
    expect(decryptSecret(token)).toBe('hunter2');
  });

  it('produces a different ciphertext each call (random IV)', () => {
    expect(encryptSecret('x')).not.toBe(encryptSecret('x'));
  });

  it('throws when the ciphertext is tampered with', () => {
    const token = encryptSecret('hunter2');
    const parts = token.split(':');
    parts[3] = Buffer.from('garbage').toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });

  it('reports configuration state from the key', () => {
    expect(isEncryptionConfigured()).toBe(true);
    process.env.CONFIG_ENCRYPTION_KEY = '';
    expect(isEncryptionConfigured()).toBe(false);
  });
});
