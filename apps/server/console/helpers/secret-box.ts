import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

// Secrets the Console itself has to keep, which today is the org-wide AI key.
//
// Deliberately NOT the project-side helpers/crypto.helper: that one reads
// CONFIG_ENCRYPTION_KEY, and every project is provisioned with its own (see
// buildManifest). The Console has no such key of its own, so this derives one
// from the console session secret, which is already required to be set in
// production and is already the thing that protects operator sessions.
//
// Consequence, and it is the right trade: rotating CONSOLE_JWT_SECRET makes the
// stored ciphertext unreadable. `open` returns null rather than throwing, so a
// rotated console shows "no key configured" and asks for it again instead of
// failing every org settings read.

const ALGO = 'aes-256-gcm';

export interface SecretBox {
  seal(plaintext: string): string;
  open(token: string): string | null;
}

export function createSecretBox(secret: string): SecretBox {
  // sha256 of the session secret, not the secret's bytes: CONSOLE_JWT_SECRET is
  // an arbitrary-length string and aes-256 needs exactly 32 bytes.
  const key = createHash('sha256').update(secret, 'utf8').digest();

  return {
    seal(plaintext: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGO, key, iv);
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
    },

    open(token: string): string | null {
      const [version, ivB64, tagB64, ctB64] = String(token ?? '').split(':');
      if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) return null;
      try {
        const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
        decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
      } catch {
        // Wrong key (rotated secret) or a tampered token. Both mean "this is not
        // readable here", which the caller renders as "no key configured".
        return null;
      }
    },
  };
}
