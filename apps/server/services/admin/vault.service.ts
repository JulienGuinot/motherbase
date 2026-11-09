import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import BaseContext from '../../context/base-context';
import { HttpException } from '../../exceptions/http-exception';
import { deriveKey } from '../../helpers/crypto.helper';
import { formatSqlError } from '../../lib/pg-error';
import { QUIET_TRANSACTION_SQL } from '../../lib/quiet-transaction';
import { quoteIdentCatalog } from '../../lib/sql-identifier';
import { invalidateCatalog } from '../rest-api/catalog';
import { execDdl } from './schema-ddl';

/**
 * Supabase Vault, without pgsodium.
 *
 * Supabase's Vault is `supabase_vault` on top of pgsodium, neither of which is
 * in this image. What it offers is kept to the letter: a `vault` schema with
 * `vault.secrets` (ciphertext only), the `vault.decrypted_secrets` view and
 * `vault.create_secret` / `vault.update_secret` with Supabase's signatures, so
 * SQL written against Supabase's Vault runs here unchanged.
 *
 * The encryption is pgcrypto's `pgp_sym_encrypt` (AES-256). The design point is
 * where the key lives, and the answer is: never in the database. It is derived
 * from this server's CONFIG_ENCRYPTION_KEY (HKDF, purpose `vault`) and handed to
 * Postgres per transaction in the `vault.key` setting, with `SET LOCAL`
 * semantics, so it exists only inside the transaction that asked for it and
 * dies with it. A dump, a backup, a replica or a stolen volume holds ciphertext
 * and no key. This is pgsodium's own model (its root key is read from the
 * server, not stored in a table), minus the extension.
 *
 * The cost of that choice, stated plainly: a session the server did not open
 * (psql, a pg_cron job) cannot decrypt, and `vault.decrypted_secrets` raises
 * there with a hint saying why. Secrets are read and written through Studio,
 * the CLI and the admin API, which open such a transaction.
 *
 * Nothing in the key path is logged: the key and every plaintext travel as bound
 * parameters, and the transaction first switches statement logging off for
 * itself (superuser only, which is what this server connects as), so a
 * `log_statement = all` database does not write them to its log either.
 */

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;

export interface VaultSecret {
  id: string;
  name: string | null;
  description: string;
  keyId: string | null;
  /** Encrypted under the key this server derives now. False after a root key rotation. */
  keyMatches: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VaultStatus {
  /** The `vault` schema is installed in this database. */
  enabled: boolean;
  /** CONFIG_ENCRYPTION_KEY is set, so this server can encrypt and decrypt. */
  keyConfigured: boolean;
}

/** The server's vault key and its public fingerprint, stored as each secret's key_id. */
export interface VaultKey {
  key: string;
  keyId: string;
}

/**
 * The vault key, or null without a root key. The key id is a UUID-shaped hash of
 * the key: safe to store beside the ciphertext, and what tells a secret sealed
 * under an older root key from one that is simply corrupt.
 */
export function vaultKey(): VaultKey | null {
  const raw = deriveKey('vault');
  if (!raw) return null;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const keyId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  return { key: raw.toString('hex'), keyId };
}

/**
 * The `vault` schema. Idempotent, so enabling twice (or after an upgrade that
 * changed a function body) converges instead of failing.
 *
 * Everything is revoked from PUBLIC: the owner (the superuser this server
 * connects as) is the only role that can touch the vault. anon, authenticated
 * and service_role cannot, which also keeps it off the REST API.
 */
export function vaultInstallStatements(pgcryptoSchema: string): string[] {
  const pgcrypto = quoteIdentCatalog(pgcryptoSchema);
  const encrypt = `encode(${pgcrypto}.pgp_sym_encrypt(%s, vault._session_key(), 'cipher-algo=aes256'), 'base64')`;
  return [
    'CREATE SCHEMA IF NOT EXISTS vault',
    'REVOKE ALL ON SCHEMA vault FROM PUBLIC',
    `CREATE TABLE IF NOT EXISTS vault.secrets (
       id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       name        text UNIQUE,
       description text NOT NULL DEFAULT '',
       secret      text NOT NULL,
       key_id      uuid,
       nonce       bytea,
       created_at  timestamptz NOT NULL DEFAULT now(),
       updated_at  timestamptz NOT NULL DEFAULT now()
     )`,
    `COMMENT ON TABLE vault.secrets IS 'Motherbase Vault. secret is pgp_sym_encrypt ciphertext (base64); the key is held by the API server, never by the database. Read plaintext through vault.decrypted_secrets in a server-opened session.'`,
    `CREATE OR REPLACE FUNCTION vault._session_key() RETURNS text
       LANGUAGE plpgsql STABLE SET search_path = '' AS $$
       DECLARE k text := current_setting('vault.key', true);
       BEGIN
         IF k IS NULL OR k = '' THEN
           RAISE EXCEPTION 'The vault key is not available in this session'
             USING HINT = 'Motherbase keeps the vault key outside the database. Read and write secrets through Studio, the CLI or the admin API, which supply it for the transaction.';
         END IF;
         RETURN k;
       END $$`,
    `CREATE OR REPLACE FUNCTION vault._session_key_id() RETURNS uuid
       LANGUAGE sql STABLE SET search_path = '' AS $$
       SELECT nullif(current_setting('vault.key_id', true), '')::uuid $$`,
    `CREATE OR REPLACE FUNCTION vault._decrypt(ciphertext text, sealed_with uuid) RETURNS text
       LANGUAGE plpgsql STABLE SET search_path = '' AS $$
       -- The key first: "no key in this session" is the more useful error when
       -- both apply, and it is the one a session outside the server always hits.
       DECLARE k text := vault._session_key();
       BEGIN
         IF sealed_with IS DISTINCT FROM vault._session_key_id() THEN
           RAISE EXCEPTION 'This secret was encrypted under a different vault key'
             USING HINT = 'CONFIG_ENCRYPTION_KEY changed since it was stored. Restore the previous key, or set the secret again.';
         END IF;
         RETURN ${pgcrypto}.pgp_sym_decrypt(decode(ciphertext, 'base64'), k);
       END $$`,
    `CREATE OR REPLACE FUNCTION vault.create_secret(
         new_secret text, new_name text DEFAULT NULL, new_description text DEFAULT '', new_key_id uuid DEFAULT NULL)
       RETURNS uuid LANGUAGE plpgsql SET search_path = '' AS $$
       DECLARE created uuid;
       BEGIN
         INSERT INTO vault.secrets (secret, name, description, key_id)
         VALUES (${encrypt.replace('%s', 'new_secret')}, new_name, coalesce(new_description, ''), vault._session_key_id())
         RETURNING id INTO created;
         RETURN created;
       END $$`,
    `COMMENT ON FUNCTION vault.create_secret(text, text, text, uuid) IS 'Supabase-compatible. new_key_id is accepted and ignored: every secret is sealed with the server-held vault key.'`,
    `CREATE OR REPLACE FUNCTION vault.update_secret(
         secret_id uuid, new_secret text DEFAULT NULL, new_name text DEFAULT NULL,
         new_description text DEFAULT NULL, new_key_id uuid DEFAULT NULL)
       RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
       BEGIN
         UPDATE vault.secrets SET
           secret      = CASE WHEN new_secret IS NULL THEN secret ELSE ${encrypt.replace('%s', 'new_secret')} END,
           key_id      = CASE WHEN new_secret IS NULL THEN key_id ELSE vault._session_key_id() END,
           name        = coalesce(new_name, name),
           description = coalesce(new_description, description),
           updated_at  = now()
         WHERE id = secret_id;
       END $$`,
    `CREATE OR REPLACE VIEW vault.decrypted_secrets AS
       SELECT id, name, description, secret, vault._decrypt(secret, key_id) AS decrypted_secret,
              key_id, nonce, created_at, updated_at
         FROM vault.secrets`,
    'REVOKE ALL ON ALL TABLES IN SCHEMA vault FROM PUBLIC',
    'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA vault FROM PUBLIC',
  ];
}

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));

export class VaultService extends BaseContext {
  async status(): Promise<VaultStatus> {
    return { enabled: await this.isEnabled(), keyConfigured: vaultKey() !== null };
  }

  async list(): Promise<VaultStatus & { secrets: VaultSecret[] }> {
    const status = await this.status();
    if (!status.enabled) return { ...status, secrets: [] };
    const current = vaultKey()?.keyId ?? null;
    const rows = await this.di.prisma.$queryRawUnsafe<Row[]>(
      `SELECT id::text, name, description, key_id::text, created_at, updated_at
         FROM vault.secrets ORDER BY name NULLS LAST, created_at`,
    );
    return {
      ...status,
      secrets: rows.map(row => ({
        id: String(row.id),
        name: row.name == null ? null : String(row.name),
        description: String(row.description ?? ''),
        keyId: row.key_id == null ? null : String(row.key_id),
        keyMatches: current !== null && row.key_id === current,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      })),
    };
  }

  async enable(): Promise<void> {
    await this.di.prisma.$transaction(async tx => {
      await execDdl(tx, 'CREATE EXTENSION IF NOT EXISTS pgcrypto');
      const [row] = await tx.$queryRawUnsafe<Row[]>(
        `SELECT extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname = 'pgcrypto'`,
      );
      for (const sql of vaultInstallStatements(String(row.schema))) await execDdl(tx, sql);
    });
    invalidateCatalog();
  }

  async create(input: { name: string; secret: string; description?: string }): Promise<VaultSecret> {
    const id = await this.withKey(async tx => {
      const [row] = await tx.$queryRawUnsafe<Row[]>(
        'SELECT vault.create_secret($1, $2, $3)::text AS id',
        input.secret,
        input.name,
        input.description ?? '',
      );
      return String(row.id);
    });
    return this.get(id);
  }

  async update(id: string, patch: { name?: string; secret?: string; description?: string }): Promise<VaultSecret> {
    await this.get(id);
    await this.withKey(tx =>
      tx.$executeRawUnsafe(
        'SELECT vault.update_secret($1::uuid, $2, $3, $4)',
        id,
        patch.secret ?? null,
        patch.name ?? null,
        patch.description ?? null,
      ),
    );
    return this.get(id);
  }

  /** The plaintext. The one read that decrypts, and the reason /vault is a secrets.manage surface. */
  async reveal(id: string): Promise<string> {
    await this.get(id);
    return this.withKey(async tx => {
      const [row] = await tx.$queryRawUnsafe<Row[]>(
        'SELECT decrypted_secret FROM vault.decrypted_secrets WHERE id = $1::uuid',
        id,
      );
      return String(row.decrypted_secret ?? '');
    });
  }

  async remove(id: string): Promise<void> {
    await this.requireEnabled();
    const deleted = await this.di.prisma.$executeRawUnsafe('DELETE FROM vault.secrets WHERE id = $1::uuid', id);
    if (!deleted) throw new HttpException('Secret not found', 404);
  }

  /** Look a secret up by its unique name, as other features (Wrappers) refer to theirs. */
  async findByName(name: string): Promise<VaultSecret | undefined> {
    return (await this.list()).secrets.find(secret => secret.name === name);
  }

  /** Create the named secret, or replace its value when it already exists. */
  async upsertByName(name: string, secret: string, description: string): Promise<VaultSecret> {
    if (!(await this.isEnabled())) await this.enable();
    const existing = await this.findByName(name);
    return existing
      ? this.update(existing.id, { secret, description })
      : this.create({ name, secret, description });
  }

  async get(id: string): Promise<VaultSecret> {
    const secret = (await this.list()).secrets.find(s => s.id === id);
    if (!secret) throw new HttpException('Secret not found', 404);
    return secret;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async isEnabled(): Promise<boolean> {
    const [row] = await this.di.prisma.$queryRawUnsafe<Row[]>(
      `SELECT to_regclass('vault.secrets') IS NOT NULL AS enabled`,
    );
    return Boolean(row?.enabled);
  }

  private async requireEnabled(): Promise<void> {
    if (!(await this.isEnabled())) {
      throw new HttpException('Vault is not enabled for this project. Enable it first.', 400);
    }
  }

  /**
   * Run `fn` in a transaction that holds the vault key, and only that
   * transaction: `set_config(..., true)` is SET LOCAL, so the key never outlives
   * the COMMIT and never reaches another request on the pooled connection.
   */
  private async withKey<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    await this.requireEnabled();
    const key = vaultKey();
    if (!key) {
      throw new HttpException(
        'Vault needs CONFIG_ENCRYPTION_KEY (a base64 32-byte key) on this server: the vault key is derived from it ' +
          'and never stored in the database. Set it and restart the API.',
        400,
      );
    }
    try {
      return await this.di.prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe(QUIET_TRANSACTION_SQL);
        await tx.$queryRawUnsafe(
          `SELECT set_config('vault.key', $1, true), set_config('vault.key_id', $2, true)`,
          key.key,
          key.keyId,
        );
        return fn(tx);
      });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      // formatSqlError keeps Postgres's ERROR and HINT lines, never parameters,
      // so neither the key nor a plaintext can surface in this message.
      throw new HttpException(formatSqlError(err) || 'Vault operation failed', 400);
    }
  }
}
