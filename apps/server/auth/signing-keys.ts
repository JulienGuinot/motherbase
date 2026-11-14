import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, type JsonWebKey } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { HttpException } from '../exceptions/http-exception';

// JWT signing keys, Supabase-style.
//
// Access tokens (`/api/auth/token`, the `set-auth-jwt` header) are signed by
// Better Auth's jwt plugin with a row of `auth.jwks`. What the plugin does not
// have is a lifecycle: it signs with the newest row and never retires one. The
// lifecycle lives here, and the plugin reaches the table only through the
// adapter at the bottom of this file, so both agree on which key signs.
//
//   standby          published in the JWKS so verifiers cache it ahead of time,
//                    signs nothing yet
//   in_use           the one key that signs (a partial unique index holds this)
//   previously_used  no longer signs, still verifies the tokens it issued
//   revoked          dropped from the JWKS: its tokens stop verifying

export const SIGNING_KEY_STATUSES = ['standby', 'in_use', 'previously_used', 'revoked'] as const;
export type SigningKeyStatus = (typeof SIGNING_KEY_STATUSES)[number];

export const SIGNING_ALGORITHMS = ['ES256', 'RS256', 'EdDSA'] as const;
export type SigningAlgorithm = (typeof SIGNING_ALGORITHMS)[number];

/** Supabase's default, and the smallest tokens of the three. */
export const DEFAULT_SIGNING_ALGORITHM: SigningAlgorithm = 'ES256';

export interface SigningKeyRow {
  id: string;
  publicKey: string;
  privateKey: string;
  alg: string | null;
  crv: string | null;
  status: string;
  createdAt: Date;
  expiresAt: Date | null;
}

export type SigningKeyAction = 'rotate' | 'revoke' | 'delete';

/** Status changes one action makes, applied by the caller in one transaction. */
export type StatusChange = { id: string; status: SigningKeyStatus } | { id: string; delete: true };

/**
 * What an action does to the key set, or why it is refused.
 *
 * Pure so the rules are testable without a database:
 *  - rotate: a standby key starts signing; the key it replaces keeps verifying.
 *  - revoke: only a previously used key. Revoking the key in use would leave
 *    nothing to sign with, and a standby key has issued nothing to revoke.
 *  - delete: only a key that verifies nothing (standby or revoked). Deleting a
 *    previously used key would silently do what revoke does, without the
 *    status that says so.
 */
export function planSigningKeyAction(
  keys: ReadonlyArray<Pick<SigningKeyRow, 'id' | 'status'>>,
  action: SigningKeyAction,
  id: string,
): StatusChange[] {
  const key = keys.find(k => k.id === id);
  if (!key) throw new HttpException(`Signing key not found: ${id}`, 404);

  switch (action) {
    case 'rotate': {
      if (key.status !== 'standby') {
        throw new HttpException(`Only a standby key can be rotated in (this one is ${key.status})`, 409);
      }
      const current = keys.filter(k => k.status === 'in_use');
      return [...current.map(k => ({ id: k.id, status: 'previously_used' as const })), { id, status: 'in_use' }];
    }
    case 'revoke':
      if (key.status !== 'previously_used') {
        throw new HttpException(`Only a previously used key can be revoked (this one is ${key.status})`, 409);
      }
      return [{ id, status: 'revoked' }];
    case 'delete':
      if (key.status !== 'standby' && key.status !== 'revoked') {
        throw new HttpException(`Only a standby or revoked key can be deleted (this one is ${key.status}); revoke it first`, 409);
      }
      return [{ id, delete: true }];
  }
}

export interface GeneratedKey {
  kid: string;
  alg: SigningAlgorithm;
  crv?: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}

function keyPairFor(alg: SigningAlgorithm) {
  if (alg === 'ES256') return generateKeyPairSync('ec', { namedCurve: 'P-256' });
  if (alg === 'RS256') return generateKeyPairSync('rsa', { modulusLength: 2048 });
  return generateKeyPairSync('ed25519');
}

const CURVE: Partial<Record<SigningAlgorithm, string>> = { ES256: 'P-256', EdDSA: 'Ed25519' };

/** A fresh key pair as JWKs. The CLI's `gen signing-key` produces the same shape. */
export function generateSigningKey(alg: SigningAlgorithm = DEFAULT_SIGNING_ALGORITHM): GeneratedKey {
  const { publicKey, privateKey } = keyPairFor(alg);
  return {
    kid: randomUUID(),
    alg,
    crv: CURVE[alg],
    publicJwk: publicKey.export({ format: 'jwk' }),
    privateJwk: privateKey.export({ format: 'jwk' }),
  };
}

/** Which algorithm a JWK signs or verifies with, or null when it is none we accept. */
export function algorithmOf(jwk: JsonWebKey): SigningAlgorithm | null {
  if (jwk.kty === 'EC' && jwk.crv === 'P-256') return 'ES256';
  if (jwk.kty === 'RSA') return 'RS256';
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') return 'EdDSA';
  return null;
}

/**
 * Accept an operator-supplied private key (Supabase lets you import one, e.g.
 * the output of `motherbase gen signing-key`). The public half is derived here,
 * never trusted from the input: a mismatched pair would publish a key that
 * verifies nothing this project signs.
 */
export function importSigningKey(input: unknown): GeneratedKey {
  const jwk = (input ?? {}) as JsonWebKey & { kid?: unknown; alg?: unknown };
  const alg = algorithmOf(jwk);
  if (!alg) throw new HttpException('privateKey must be an ES256 (P-256), RS256 or EdDSA (Ed25519) JWK', 400);
  if (jwk.alg !== undefined && jwk.alg !== alg) {
    throw new HttpException(`privateKey says alg ${String(jwk.alg)} but is a ${alg} key`, 400);
  }
  if (!jwk.d) throw new HttpException('privateKey must be a private JWK (it has no "d")', 400);
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: jwk, format: 'jwk' });
  } catch {
    throw new HttpException('privateKey is not a valid JWK', 400);
  }
  // The kid becomes the row id and the `kid` of every token this key signs.
  const kid = typeof jwk.kid === 'string' && /^[A-Za-z0-9_.-]{8,128}$/.test(jwk.kid) ? jwk.kid : randomUUID();
  return {
    kid,
    alg,
    crv: CURVE[alg],
    publicJwk: createPublicKey(privateKey).export({ format: 'jwk' }),
    privateJwk: privateKey.export({ format: 'jwk' }),
  };
}

/** A key as the admin API shows it: never the private half. */
export function describeSigningKey(row: SigningKeyRow) {
  return {
    id: row.id,
    algorithm: row.alg ?? 'EdDSA',
    status: row.status as SigningKeyStatus,
    publicJwk: { ...JSON.parse(row.publicKey), kid: row.id, alg: row.alg ?? 'EdDSA', use: 'sig' },
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The rows Better Auth may see: everything but revoked keys, with every key
 * but the one in use reported as expired as of `now`.
 *
 * Better Auth 1.7 signs with the newest live key of its default algorithm,
 * then the newest live key of any (jwt plugin, resolveSigningKey). Neither
 * rule knows about rotation: a standby key is usually the newest, and a key
 * rotated in with another algorithm would lose to an older ES256 one. Only
 * the key in use being live settles both. Verification reads every key
 * regardless of expiry, so a previously used key keeps verifying until it is
 * revoked, and the plugin's own /jwks still publishes them within its grace
 * period. The real dates are kept by the signing-keys API; this view is only
 * the plugin's.
 */
export function jwksForBetterAuth(rows: SigningKeyRow[], now = new Date()): SigningKeyRow[] {
  return rows
    .filter(row => row.status !== 'revoked')
    .map(row => (row.status === 'in_use' ? row : { ...row, expiresAt: now }));
}

/** Better Auth's Jwk spells "absent" as undefined where Prisma says null. */
function toBetterAuthJwk(row: SigningKeyRow) {
  return {
    ...row,
    alg: (row.alg ?? undefined) as SigningAlgorithm | undefined,
    crv: (row.crv ?? undefined) as 'Ed25519' | 'P-256' | undefined,
    expiresAt: row.expiresAt ?? undefined,
  };
}

/**
 * The adapter handed to Better Auth's jwt plugin (`jwt({ adapter })`).
 *
 * createJwk runs only when no key signs yet: a new project, or one whose key
 * in use was just deleted by hand. The new key goes straight to in_use. Two
 * requests racing here both generate one; the partial unique index lets the
 * first in and the loser signs with the winner's key.
 */
export function signingKeyAdapter(prisma: PrismaClient, onKeyCreated: () => void = () => {}) {
  const rows = () => prisma.jwks.findMany({ orderBy: { createdAt: 'asc' } }) as Promise<SigningKeyRow[]>;
  return {
    getJwks: async () => jwksForBetterAuth(await rows()).map(toBetterAuthJwk),
    createJwk: async (webKey: { publicKey: string; privateKey: string; alg?: string; crv?: string }) => {
      try {
        const created = await prisma.jwks.create({
          data: {
            publicKey: webKey.publicKey,
            privateKey: webKey.privateKey,
            alg: webKey.alg ?? DEFAULT_SIGNING_ALGORITHM,
            crv: webKey.crv ?? null,
            status: 'in_use',
          },
        });
        onKeyCreated();
        return toBetterAuthJwk(created);
      } catch (error) {
        const current = await prisma.jwks.findFirst({ where: { status: 'in_use' } });
        if (current) return toBetterAuthJwk(current);
        throw error;
      }
    },
  };
}
