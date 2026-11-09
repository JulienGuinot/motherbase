import { describe, expect, it } from 'vitest';
import { signUploadToken, verifyUploadToken } from '../services/storage/upload-token';

const file = { id: 'file', bucket: 'uploads', key: 'photos/x.png', size: 3, ownerId: null };
const secret = 'test-secret';

describe('signed upload finalization capability', () => {
  it('allows only the exact reservation until expiry', () => {
    const token = signUploadToken(file, 2000, secret);
    expect(verifyUploadToken(token, file, secret, 1000)).toBe(true);
    expect(verifyUploadToken(token, file, secret, 2000)).toBe(false);
    for (const other of [{ id: 'other' }, { bucket: 'public' }, { key: 'other' }, { size: 99 }, { ownerId: 'user' }]) {
      expect(verifyUploadToken(token, { ...file, ...other }, secret, 1000)).toBe(false);
    }
    expect(verifyUploadToken(token, file, 'wrong-secret', 1000)).toBe(false);
    expect(verifyUploadToken(token.replace('2000', '3000'), file, secret, 1000)).toBe(false);
  });

  it.each([undefined, null, {}, '', 'Infinity.x', '2000.bad'])('refuses malformed tokens %s', token => {
    expect(verifyUploadToken(token, file, secret, 1000)).toBe(false);
  });
});
