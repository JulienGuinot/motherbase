import { createHash } from 'crypto';
import { z } from 'zod';
import BaseContext from '../../context/base-context';
import { env } from '../../config/env';
import { HttpException } from '../../exceptions/http-exception';
import { resolveBaseUrl } from '../../auth/auth-origins';
import {
  DEFAULT_SIGNING_ALGORITHM,
  SIGNING_ALGORITHMS,
  describeSigningKey,
  generateSigningKey,
  importSigningKey,
  planSigningKeyAction,
  type SigningKeyAction,
  type SigningKeyRow,
} from '../../auth/signing-keys';
import { invalidateSigningKeys } from '../../auth/access-tokens';

export const createSigningKeySchema = z
  .object({
    algorithm: z.enum(SIGNING_ALGORITHMS).optional(),
    /** A private JWK to import instead of generating one. */
    privateKey: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * The admin side of the signing-key lifecycle (see auth/signing-keys.ts for
 * the rules). Better Auth reads the same table through the adapter there, so a
 * rotation here is what the next `/api/auth/token` signs with.
 */
export class SigningKeyService extends BaseContext {
  private rows(): Promise<SigningKeyRow[]> {
    return this.di.prisma.jwks.findMany({ orderBy: { createdAt: 'asc' } });
  }

  async list() {
    const rows = await this.rows();
    return {
      keys: rows.map(describeSigningKey),
      // The `iss` and `aud` every access token carries, and what a verifier
      // (and `motherbase gen bearer-jwt`) has to match.
      issuer: resolveBaseUrl(env.BASE_HOST, env.IS_PRODUCTION),
      jwksPath: '/auth/v1/.well-known/jwks.json',
      legacy: {
        algorithm: 'HS256',
        // A fingerprint, never the secret: enough to tell two projects apart.
        fingerprint: createHash('sha256').update(env.JWT_SECRET).digest('hex').slice(0, 16),
        // JWT_SECRET signs session cookies and internal HMACs (upload tokens,
        // OAuth state). No access token is HS256 here, so there is no legacy
        // token to revoke; rotating the secret itself signs every user out and
        // belongs to the project's environment, not to this list.
        usedFor: ['session cookies', 'upload tokens', 'oauth state'],
      },
    };
  }

  /** Public keys of every key that may still verify a token. */
  async jwks() {
    const rows = await this.rows();
    return { keys: rows.filter(row => row.status !== 'revoked').map(row => describeSigningKey(row).publicJwk) };
  }

  /** New keys always start in standby: nothing signs with a key until it is rotated in. */
  async create(input: unknown) {
    const parsed = createSigningKeySchema.safeParse(input ?? {});
    if (!parsed.success) throw new HttpException(parsed.error.issues.map(i => i.message).join('; '), 400);
    const key = parsed.data.privateKey
      ? importSigningKey(parsed.data.privateKey)
      : generateSigningKey(parsed.data.algorithm ?? DEFAULT_SIGNING_ALGORITHM);
    if (await this.di.prisma.jwks.findUnique({ where: { id: key.kid } })) {
      throw new HttpException(`A signing key with kid ${key.kid} already exists`, 409);
    }
    const row = await this.di.prisma.jwks.create({
      data: {
        id: key.kid,
        publicKey: JSON.stringify(key.publicJwk),
        privateKey: JSON.stringify(key.privateJwk),
        alg: key.alg,
        crv: key.crv ?? null,
        status: 'standby',
      },
    });
    invalidateSigningKeys();
    return describeSigningKey(row);
  }

  rotate(id: string) {
    return this.apply('rotate', id);
  }

  revoke(id: string) {
    return this.apply('revoke', id);
  }

  remove(id: string) {
    return this.apply('delete', id);
  }

  /**
   * One action as one transaction. Rotation demotes the old key before
   * promoting the new one, which is the order the one-in-use index needs.
   */
  private async apply(action: SigningKeyAction, id: string) {
    await this.di.prisma.$transaction(async tx => {
      const rows = await tx.jwks.findMany({ select: { id: true, status: true } });
      for (const change of planSigningKeyAction(rows, action, id)) {
        if ('delete' in change) await tx.jwks.delete({ where: { id: change.id } });
        else await tx.jwks.update({ where: { id: change.id }, data: { status: change.status } });
      }
    });
    // After the commit: this is what makes a revoked key stop verifying now.
    invalidateSigningKeys();
    return this.list();
  }
}
