import { AsyncLocalStorage } from 'node:async_hooks';
import type { PrismaClient } from '@prisma/client';
import { decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from 'jose';
import { algorithmOf, jwksForBetterAuth, type SigningKeyRow } from './signing-keys';

// Access tokens: the short-lived JWTs `/api/auth/token` hands out, and how this
// server accepts one without asking the database who the caller is.
//
// A session token is a row: every request that presents one costs a session
// lookup and a user lookup. An access token is a signature over the caller's
// identity, so verifying it is arithmetic against a key held in memory. The
// data plane (REST, storage, realtime broadcast) takes the caller from the
// token's claims; routes that need the whole user row still load it.
//
// What a signature cannot say is that the session behind it was revoked, or
// that the user's role changed, a second ago. Two things close that gap in
// this process: `revokeAccessTokens` (called wherever a session ends or a user's
// standing changes) and the boot cutoff below. Outside this process (another
// instance, SQL by hand) a token stays good until it expires, which is the
// lifetime an operator sets in Auth settings.

/** Claims this server adds to every token it mints (see `accessTokenClaims`). */
export const ACCESS_TOKEN_CLAIMS = {
  /** The user's application role (`auth.users.role`), not the Postgres role. */
  role: 'user_role',
  anonymous: 'is_anonymous',
  /**
   * `auth.users.status`. Only a token that says `active` is acted on by itself:
   * any other value sends it down the path that reads the row, as a session
   * for that account would be.
   */
  status: 'user_status',
  /**
   * When the request that minted the token began, in milliseconds. `iat` is in
   * seconds, which cannot order a token against a revocation that happened in
   * the same one. A token without it was not minted by this server (`motherbase
   * gen bearer-jwt`): it belongs to no session, so no revocation applies to it.
   */
  issuedMs: 'iat_ms',
} as const;

/**
 * When the auth request being served began. The token is dated with this, not
 * with the time its payload is built: the session and the user are read first,
 * and a revocation that commits between that read and the signature would
 * otherwise produce a token dated after the cutoff that carries what the
 * revocation replaced. Dated from before the read, such a token is refused.
 */
const mintStartedAt = new AsyncLocalStorage<number>();

/** Run one auth request, so a token it mints is dated from its start. */
export function datingAccessTokens<T>(handle: () => T): T {
  return mintStartedAt.run(Date.now(), handle);
}

type TokenSubject = { id?: unknown; email?: unknown; role?: unknown; isAnonymous?: unknown; status?: unknown };

/**
 * The claims the data plane reads, laid over whatever the token already holds.
 * Spread last by the caller, so neither the default payload nor the custom
 * claims hook can leave one out or give it another meaning.
 */
export function accessTokenClaims(
  user: TokenSubject,
  startedAt: number | undefined = mintStartedAt.getStore(),
): Record<string, unknown> {
  return {
    email: typeof user.email === 'string' ? user.email : null,
    [ACCESS_TOKEN_CLAIMS.role]: typeof user.role === 'string' ? user.role : null,
    [ACCESS_TOKEN_CLAIMS.anonymous]: !!user.isAnonymous,
    [ACCESS_TOKEN_CLAIMS.status]: typeof user.status === 'string' ? user.status : null,
    // Minted outside a request (a server-side `auth.api` call): nothing says
    // when the user was read, so the token is left undated and every use of it
    // reads the row instead.
    ...(startedAt === undefined ? {} : { [ACCESS_TOKEN_CLAIMS.issuedMs]: startedAt }),
  };
}

/** The caller an access token names, when its claims are enough to act on. */
export interface AccessTokenUser {
  id: string;
  role: string;
  email: string | null;
  isAnonymous: boolean;
}

export interface VerifiedAccessToken {
  /** The `sub` claim: the user id. */
  subject: string;
  /**
   * The caller as the token describes it, or null when the token cannot stand
   * for its user: it is undated (minted offline with an imported key), or its
   * account was not active. Such a token only says who: the row has to be read
   * for the rest.
   */
  user: AccessTokenUser | null;
  /** `iat_ms`, when the token has one: what a revocation is compared against. */
  issuedMs: number | null;
}

// ── Signing keys ────────────────────────────────────────────────────────────

type VerificationKey = { key: Awaited<ReturnType<typeof importJWK>>; alg: string };

/** How long the key set is trusted before `auth.jwks` is read again. */
const KEY_TTL_MS = 30_000;
/** A token naming a key this process has not seen forces a re-read, at most this often. */
const UNKNOWN_KEY_RELOAD_MS = 1_000;

let keys: Map<string, VerificationKey> | null = null;
let keysLoadedAt = 0;
/** Bumped by `invalidateSigningKeys`, so a load already in flight is neither kept nor joined. */
let keysVersion = 0;
let keysLoading: { version: number; keys: Promise<Map<string, VerificationKey>> } | null = null;

/**
 * Forget the key set. Called by everything that changes `auth.jwks` in this
 * process, which is what makes a revoked key stop verifying immediately here.
 * The TTL is for a change made anywhere else.
 */
export function invalidateSigningKeys(): void {
  keys = null;
  keysVersion += 1;
}

async function loadKeys(prisma: PrismaClient): Promise<Map<string, VerificationKey>> {
  const startedAt = keysVersion;
  const rows = (await prisma.jwks.findMany()) as SigningKeyRow[];
  const loaded = new Map<string, VerificationKey>();
  // The same set Better Auth verifies against: every key that is not revoked.
  for (const row of jwksForBetterAuth(rows)) {
    try {
      const jwk = JSON.parse(row.publicKey);
      // The algorithm is read off the key, which also covers rows written
      // before it was recorded. A row that names another one (or a symmetric
      // key, whose "public" half is the secret) verifies nothing.
      const alg = algorithmOf(jwk);
      if (alg && (!row.alg || row.alg === alg)) loaded.set(row.id, { key: await importJWK(jwk, alg), alg });
    } catch {
      // One unreadable row must not take every other key down with it.
    }
  }
  if (keysVersion === startedAt) {
    keys = loaded;
    keysLoadedAt = Date.now();
  }
  return loaded;
}

/** Concurrent callers share one read, unless the key set changed since it started. */
function loadKeysOnce(prisma: PrismaClient): Promise<Map<string, VerificationKey>> {
  if (keysLoading?.version === keysVersion) return keysLoading.keys;
  const loading = { version: keysVersion, keys: loadKeys(prisma) };
  keysLoading = loading;
  const done = () => {
    if (keysLoading === loading) keysLoading = null;
  };
  loading.keys.then(done, done);
  return loading.keys;
}

async function verificationKey(prisma: PrismaClient, kid: string): Promise<VerificationKey | undefined> {
  const fresh = keys && Date.now() - keysLoadedAt < KEY_TTL_MS;
  const version = keysVersion;
  let current = fresh ? keys! : await loadKeysOnce(prisma);
  // A key created by another instance, or rotated in since the last read.
  const unknown = !current.has(kid) && fresh && Date.now() - keysLoadedAt > UNKNOWN_KEY_RELOAD_MS;
  // The set changed while it was being read: what came back may hold a key
  // that was revoked in the meantime.
  if (unknown || keysVersion !== version) current = await loadKeysOnce(prisma);
  return current.get(kid);
}

// ── Verification ────────────────────────────────────────────────────────────

function callerFrom(payload: JWTPayload): Pick<VerifiedAccessToken, 'user' | 'issuedMs'> {
  const issuedMs = payload[ACCESS_TOKEN_CLAIMS.issuedMs];
  const role = payload[ACCESS_TOKEN_CLAIMS.role];
  if (typeof issuedMs !== 'number' || !Number.isFinite(issuedMs)) return { user: null, issuedMs: null };
  if (typeof role !== 'string' || payload[ACCESS_TOKEN_CLAIMS.status] !== 'active') return { user: null, issuedMs };
  return {
    issuedMs,
    user: {
      id: payload.sub!,
      role,
      email: typeof payload.email === 'string' ? payload.email : null,
      isAnonymous: payload[ACCESS_TOKEN_CLAIMS.anonymous] === true,
    },
  };
}

/**
 * Verify a token this project signed. Null for anything else: malformed,
 * expired, signed by a key that is unknown or revoked, or issued by somebody
 * else (a third-party token is not an error here, it is simply not ours).
 *
 * `issuer` is the auth instance's base URL, which Better Auth writes as both
 * `iss` and `aud` of every token it signs.
 */
export async function verifyAccessToken(
  prisma: PrismaClient,
  issuer: string | undefined,
  token: string,
): Promise<VerifiedAccessToken | null> {
  // No base URL means nothing to hold `iss` and `aud` to. Refuse rather than
  // accept a token from any issuer that happens to share a key id.
  if (!issuer) return null;
  try {
    const { kid } = decodeProtectedHeader(token);
    if (!kid) return null;
    const signer = await verificationKey(prisma, kid);
    if (!signer) return null;
    const { payload } = await jwtVerify(token, signer.key, { issuer, audience: issuer, algorithms: [signer.alg] });
    if (!payload.sub) return null;
    return { subject: payload.sub, ...callerFrom(payload) };
  } catch {
    return null;
  }
}

// ── Revocation ──────────────────────────────────────────────────────────────

/**
 * Tokens minted at or before these instants are refused. One for everybody,
 * starting at boot: the per-user entries live in memory, so a restart would
 * otherwise bring every token revoked before it back to life. A refused token
 * costs its holder one refresh, nothing else.
 */
let everyoneCutoffMs = Date.now();
const userCutoffsMs = new Map<string, number>();
/** Past this many live entries the map is traded for one cutoff for everybody. */
const MAX_USER_CUTOFFS = 100_000;
/**
 * The longest an access token can live: the ceiling of the Auth setting
 * (`AUTH_TOKEN_EXPIRY_LIMITS.accessTokenExpMin`, kept in step by a test). A
 * cutoff older than this refuses nothing, every token it covered has expired.
 */
export const MAX_ACCESS_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60_000;

/**
 * Refuse every access token already minted for this user, or for everybody
 * when the user is not known (a bulk change, a restore).
 *
 * Call it AFTER the change is committed. A token minted between the two would
 * otherwise pass the cutoff while still carrying what the change replaced.
 */
export function revokeAccessTokens(userId?: string | null, now = Date.now()): void {
  if (userId && userCutoffsMs.size >= MAX_USER_CUTOFFS) {
    for (const [id, cutoff] of userCutoffsMs) {
      if (now - cutoff > MAX_ACCESS_TOKEN_LIFETIME_MS) userCutoffsMs.delete(id);
    }
  }
  if (!userId || userCutoffsMs.size >= MAX_USER_CUTOFFS) {
    everyoneCutoffMs = now;
    userCutoffsMs.clear();
    return;
  }
  userCutoffsMs.set(userId, now);
}

/** Whether a token minted for `userId` at `issuedMs` is still to be honoured. */
export function accessTokenAccepted(userId: string, issuedMs: number): boolean {
  return issuedMs > Math.max(everyoneCutoffMs, userCutoffsMs.get(userId) ?? 0);
}

/** Test seam: start from a process that has revoked nothing and read no key. */
export function __resetAccessTokensForTests(bootMs = 0): void {
  everyoneCutoffMs = bootMs;
  userCutoffsMs.clear();
  invalidateSigningKeys();
}
