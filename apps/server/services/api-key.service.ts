import crypto from 'crypto';
import BaseContext from '../context/base-context';
import { HttpException } from '../exceptions/http-exception';

export type ApiKeyType = 'publishable' | 'secret';

/** What the data plane needs to know about the caller's key. */
export interface ResolvedApiKey {
  id: string;
  name: string;
  type: ApiKeyType;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  type: ApiKeyType;
  prefix: string;
  /** Present for publishable keys, which are public by design. Null for secrets. */
  token: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

/** Created keys return the clear token once, whatever their type. */
export interface CreatedApiKey extends ApiKeySummary {
  clearToken: string;
}

const PREFIXES: Record<ApiKeyType, string> = {
  publishable: 'mb_publishable_',
  secret: 'mb_secret_',
};

const DEFAULT_PUBLISHABLE_NAME = 'default';

/** How long a resolved key is trusted without re-reading its row. */
export const RESOLVED_KEY_TTL_MS = 30_000;

/**
 * Project API keys.
 *
 * Two types, and the difference is the whole point:
 *   * `publishable` identifies the project and nothing else. It ships in browser
 *     bundles, so it is stored in clear and readable from Studio forever. It
 *     grants exactly what an unauthenticated caller already had: RLS still runs,
 *     as `anon` or `authenticated` depending on the bearer token alongside it.
 *   * `secret` additionally runs the request as the `service_role` Postgres role,
 *     which has BYPASSRLS. It is the key a trusted server uses. It is stored as a
 *     hash and shown exactly once.
 *
 * Verification is a lookup on the unique index over sha256(token), so a wrong key
 * costs one indexed miss and never a scan-and-compare over the table.
 */
export class ApiKeyService extends BaseContext {
  /**
   * Valid keys by token hash. Every data-plane request presents the same key or
   * two, and looking it up was one round trip on each of them.
   *
   * Only keys that resolved are kept, so the map is bounded by the number of
   * keys the project has and a flood of wrong tokens cannot grow it. `revoke`
   * empties it, which makes a revocation immediate in this process; the TTL is
   * for a row changed by anything else (another instance, SQL by hand).
   */
  private resolved = new Map<string, { key: ResolvedApiKey; expiresAt: number }>();

  static hash(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  }

  /**
   * Resolve a presented token. Returns null for unknown, malformed or revoked
   * tokens: callers turn that into 401, and the three cases are deliberately
   * indistinguishable from outside.
   */
  async resolve(token: string | undefined | null): Promise<ResolvedApiKey | null> {
    const clean = typeof token === 'string' ? token.trim() : '';
    if (!clean) return null;
    const tokenHash = ApiKeyService.hash(clean);
    const cached = this.resolved.get(tokenHash);
    if (cached && cached.expiresAt > Date.now()) return cached.key;
    const row = await this.delegate().findUnique({ where: { tokenHash } });
    if (!row || row.revokedAt) {
      this.resolved.delete(tokenHash);
      return null;
    }
    const key: ResolvedApiKey = { id: row.id, name: row.name, type: row.type as ApiKeyType };
    this.resolved.set(tokenHash, { key, expiresAt: Date.now() + RESOLVED_KEY_TTL_MS });
    return key;
  }

  async list(): Promise<ApiKeySummary[]> {
    const rows = await this.delegate().findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((row: any) => this.summary(row));
  }

  async create(name: string, type: ApiKeyType): Promise<CreatedApiKey> {
    const clean = String(name ?? '').trim();
    if (!clean) throw new HttpException('Key name is required', 400);
    if (clean.length > 64) throw new HttpException('Key name must be 64 characters or fewer', 400);
    if (type !== 'publishable' && type !== 'secret') {
      throw new HttpException("Key type must be 'publishable' or 'secret'", 400);
    }

    const clearToken = PREFIXES[type] + crypto.randomBytes(24).toString('base64url');
    const row = await this.delegate().create({
      data: {
        name: clean,
        type,
        prefix: clearToken.slice(0, PREFIXES[type].length + 6),
        tokenHash: ApiKeyService.hash(clearToken),
        token: type === 'publishable' ? clearToken : null,
      },
    });
    return { ...this.summary(row), clearToken };
  }

  /**
   * Revoke, never delete: a revoked row keeps its hash, so the same token can
   * never be re-issued by a later `create` collision, and the operator can still
   * see that the key existed.
   */
  async revoke(id: string): Promise<ApiKeySummary> {
    const row = await this.delegate().findUnique({ where: { id } });
    if (!row) throw new HttpException('API key not found', 404);
    if (row.revokedAt) return this.summary(row);
    const updated = await this.delegate().update({ where: { id }, data: { revokedAt: new Date() } });
    this.resolved.clear();
    return this.summary(updated);
  }

  /**
   * The publishable key Studio shows on Connect. Created on first read rather
   * than in a migration: the seed has to produce a value nobody else can guess,
   * which is application concern, not DDL.
   */
  async ensurePublishable(): Promise<ApiKeySummary> {
    const existing = await this.delegate().findFirst({
      where: { type: 'publishable', revokedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) return this.summary(existing);
    return this.create(DEFAULT_PUBLISHABLE_NAME, 'publishable');
  }

  private summary(row: any): ApiKeySummary {
    return {
      id: row.id,
      name: row.name,
      type: row.type as ApiKeyType,
      prefix: row.prefix,
      token: row.token ?? null,
      createdAt: row.createdAt,
      revokedAt: row.revokedAt ?? null,
    };
  }

  private delegate() {
    const delegate = this.di.prisma.projectApiKey;
    if (!delegate) throw new HttpException('ProjectApiKey delegate is unavailable. Run prisma generate.', 500);
    return delegate;
  }
}
