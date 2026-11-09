import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import prisma from '../lib/prisma';
import { VaultService, vaultKey } from '../services/admin/vault.service';

/**
 * The Vault's promises, each asserted against the real database:
 *   - the table holds ciphertext only, and nothing that stores the key;
 *   - the Supabase SQL surface (create_secret, update_secret,
 *     decrypted_secrets) works inside a server-opened transaction;
 *   - outside one, decryption is refused rather than possible;
 *   - a root-key rotation is detected per secret instead of decrypting garbage.
 */

const vault = new VaultService({ prisma } as never);
const PLAINTEXT = `sk_live_${crypto.randomBytes(8).toString('hex')}`;
const NAME = `it_vault_${Date.now()}`;
const ROOT = crypto.randomBytes(32).toString('base64');
let previousRoot: string | undefined;

beforeAll(async () => {
  previousRoot = process.env.CONFIG_ENCRYPTION_KEY;
  process.env.CONFIG_ENCRYPTION_KEY = ROOT;
  await vault.enable();
  // Enabling twice converges: every statement is idempotent.
  await vault.enable();
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM vault.secrets WHERE name LIKE 'it_vault_%'`);
  process.env.CONFIG_ENCRYPTION_KEY = previousRoot;
});

describe('vault', () => {
  it('stores ciphertext only, and reveals the plaintext on request', async () => {
    const created = await vault.create({ name: NAME, secret: PLAINTEXT, description: 'stripe' });
    expect(created).toMatchObject({ name: NAME, description: 'stripe', keyMatches: true, keyId: vaultKey()!.keyId });

    const [row] = await prisma.$queryRawUnsafe<Array<{ secret: string }>>(
      'SELECT secret FROM vault.secrets WHERE id = $1::uuid',
      created.id,
    );
    expect(row.secret).not.toContain(PLAINTEXT);
    expect(await vault.reveal(created.id)).toBe(PLAINTEXT);
  });

  it('never lists a plaintext', async () => {
    const { secrets } = await vault.list();
    expect(JSON.stringify(secrets)).not.toContain(PLAINTEXT);
  });

  it('updates the value, the name and the description independently', async () => {
    const secret = (await vault.findByName(NAME))!;
    await vault.update(secret.id, { secret: 'rotated' });
    expect(await vault.reveal(secret.id)).toBe('rotated');

    const renamed = await vault.update(secret.id, { name: `${NAME}_b`, description: 'renamed' });
    expect(renamed).toMatchObject({ name: `${NAME}_b`, description: 'renamed' });
    expect(await vault.reveal(secret.id)).toBe('rotated');
  });

  it('refuses to decrypt in a session the server did not give the key', async () => {
    await expect(prisma.$queryRawUnsafe('SELECT decrypted_secret FROM vault.decrypted_secrets')).rejects.toThrow(
      /vault key is not available/,
    );
    await expect(prisma.$queryRawUnsafe(`SELECT vault.create_secret('x')`)).rejects.toThrow(
      /vault key is not available/,
    );
  });

  it('keeps the key out of every session once the transaction ends', async () => {
    const [row] = await prisma.$queryRawUnsafe<Array<{ key: string | null }>>(
      `SELECT current_setting('vault.key', true) AS key`,
    );
    expect(row.key || null).toBeNull();
  });

  it('detects a secret sealed under a different root key', async () => {
    const id = (await vault.findByName(`${NAME}_b`))!.id;
    process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    try {
      expect((await vault.get(id)).keyMatches).toBe(false);
      await expect(vault.reveal(id)).rejects.toThrow(/different vault key/);
    } finally {
      process.env.CONFIG_ENCRYPTION_KEY = ROOT;
    }
  });

  it('upserts by name, the way Wrappers stores a server credential', async () => {
    const first = await vault.upsertByName(`${NAME}_fdw`, 'one', 'fdw');
    const second = await vault.upsertByName(`${NAME}_fdw`, 'two', 'fdw');
    expect(second.id).toBe(first.id);
    expect(await vault.reveal(first.id)).toBe('two');
  });

  it('says what is missing when the server has no root key', async () => {
    process.env.CONFIG_ENCRYPTION_KEY = '';
    try {
      expect((await vault.status()).keyConfigured).toBe(false);
      await expect(vault.create({ name: `${NAME}_nokey`, secret: 'x' })).rejects.toThrow(/CONFIG_ENCRYPTION_KEY/);
    } finally {
      process.env.CONFIG_ENCRYPTION_KEY = ROOT;
    }
  });
});
