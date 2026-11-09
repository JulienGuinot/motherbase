import crypto from 'crypto';

const ALGO = 'aes-256-gcm';

function loadKey(): Buffer | null {
  const raw = process.env.CONFIG_ENCRYPTION_KEY || '';
  if (!raw) return null;
  try {
    const key = Buffer.from(raw, 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

export function isEncryptionConfigured(): boolean {
  return loadKey() !== null;
}

/**
 * A 32-byte key for one purpose, derived from the root key with HKDF, or null
 * when no root key is configured. Deriving rather than reusing the root key keeps
 * each feature's key material separate: a key handed to Postgres for the Vault
 * (see VaultService) can never decrypt a Studio-managed setting.
 */
export function deriveKey(purpose: string): Buffer | null {
  const root = loadKey();
  if (!root) return null;
  return Buffer.from(crypto.hkdfSync('sha256', root, Buffer.alloc(0), `motherbase:${purpose}`, 32));
}

export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  if (!key) throw new Error('CONFIG_ENCRYPTION_KEY is not set or not a 32-byte base64 key.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(token: string): string {
  const key = loadKey();
  if (!key) throw new Error('CONFIG_ENCRYPTION_KEY is not set or not a 32-byte base64 key.');
  const [version, ivB64, tagB64, ctB64] = token.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) throw new Error('Malformed secret token.');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
