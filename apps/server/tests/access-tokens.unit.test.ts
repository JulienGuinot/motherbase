import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, importJWK } from 'jose';
import {
  ACCESS_TOKEN_CLAIMS,
  MAX_ACCESS_TOKEN_LIFETIME_MS,
  __resetAccessTokensForTests,
  accessTokenAccepted,
  accessTokenClaims,
  datingAccessTokens,
  invalidateSigningKeys,
  revokeAccessTokens,
  verifyAccessToken,
} from '../auth/access-tokens';
import { AUTH_TOKEN_EXPIRY_LIMITS } from '../config/settings/auth.groups';
import { generateSigningKey, type GeneratedKey } from '../auth/signing-keys';
import { makeAuthMiddleware, makeIdentityResolver, makeOptionalAuthMiddleware } from '../auth/session';
import { callerFor } from '../middlewares/api-key.middleware';
import { buildClaims } from '../auth/hooks/access-token';

const ISSUER = 'http://localhost:3000';
const ACTIVE = { id: 'u1', email: 'a@b.c', role: 'ADMIN', isAnonymous: false, status: 'active' };

/** `auth.jwks` as a list the test edits, and a count of how often it was read. */
function keyTable(...keys: Array<GeneratedKey & { status?: string }>) {
  const rows = keys.map(key => ({
    id: key.kid,
    publicKey: JSON.stringify(key.publicJwk),
    privateKey: '',
    alg: key.alg as string | null,
    crv: key.crv ?? null,
    status: key.status ?? 'in_use',
    createdAt: new Date(),
    expiresAt: null,
  }));
  const findMany = vi.fn(async () => rows.map(row => ({ ...row })));
  return { rows, findMany, prisma: { jwks: { findMany }, user: { findUnique: vi.fn() } } as any };
}

/** A token as /api/auth/token mints it: the data-plane claims over the payload. */
async function mint(
  key: GeneratedKey,
  { user = ACTIVE, issuer = ISSUER, expiresIn = '15m', claims }: {
    user?: typeof ACTIVE;
    issuer?: string;
    expiresIn?: string;
    claims?: Record<string, unknown>;
  } = {},
) {
  return new SignJWT(claims ?? accessTokenClaims(user, Date.now()))
    .setProtectedHeader({ alg: key.alg, kid: key.kid })
    .setSubject(user.id)
    .setIssuer(issuer)
    .setAudience(issuer)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(await importJWK(key.privateJwk as never, key.alg));
}

function res() {
  const r: any = {};
  r.status = vi.fn(() => r);
  r.json = vi.fn(() => r);
  return r;
}

beforeEach(() => __resetAccessTokensForTests());

describe('accessTokenClaims', () => {
  it('writes what the data plane reads', () => {
    expect(accessTokenClaims(ACTIVE, 1234)).toEqual({
      email: 'a@b.c',
      user_role: 'ADMIN',
      is_anonymous: false,
      user_status: 'active',
      iat_ms: 1234,
    });
  });

  it('dates a token from the start of the request minting it, and not at all outside one', async () => {
    const before = Date.now();
    const claims = await datingAccessTokens(async () => {
      // The session and the user are read here, and a revocation may commit.
      await new Promise(resolve => setTimeout(resolve, 15));
      return accessTokenClaims(ACTIVE);
    });
    expect(claims.iat_ms).toBeGreaterThanOrEqual(before);
    expect(claims.iat_ms).toBeLessThan(Date.now() - 10);

    expect(accessTokenClaims(ACTIVE)).not.toHaveProperty(ACCESS_TOKEN_CLAIMS.issuedMs);
  });

  it('cannot be replaced by a static claim of the custom-claims hook', () => {
    const claims = buildClaims(
      {
        enabled: true,
        includeUserFields: [],
        staticClaims: { user_role: 'ADMIN', user_status: 'active', iat_ms: 9e15, is_anonymous: false, plan: 'pro' },
      },
      ACTIVE,
    );
    expect(claims).toEqual({ plan: 'pro' });
  });
});

describe('verifyAccessToken', () => {
  it('reads the caller from a token this project signed, with one read of the keys for many tokens', async () => {
    const key = generateSigningKey('ES256');
    const { prisma, findMany } = keyTable(key);

    const verified = await verifyAccessToken(prisma, ISSUER, await mint(key));
    await verifyAccessToken(prisma, ISSUER, await mint(key));

    expect(verified).toMatchObject({
      subject: 'u1',
      user: { id: 'u1', role: 'ADMIN', email: 'a@b.c', isAnonymous: false },
    });
    expect(typeof verified!.issuedMs).toBe('number');
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it.each(['ES256', 'RS256', 'EdDSA'] as const)('verifies a %s key', async alg => {
    const key = generateSigningKey(alg);
    expect(await verifyAccessToken(keyTable(key).prisma, ISSUER, await mint(key))).not.toBeNull();
  });

  it('refuses another issuer, an expired token, a forged signature and a missing base URL', async () => {
    const key = generateSigningKey('ES256');
    const { prisma } = keyTable(key);
    const token = await mint(key);

    expect(await verifyAccessToken(prisma, ISSUER, await mint(key, { issuer: 'https://elsewhere.test' }))).toBeNull();
    expect(await verifyAccessToken(prisma, ISSUER, await mint(key, { expiresIn: '-1s' }))).toBeNull();
    expect(await verifyAccessToken(prisma, ISSUER, `${token.slice(0, -4)}AAAA`)).toBeNull();
    expect(await verifyAccessToken(prisma, undefined, token)).toBeNull();
    expect(await verifyAccessToken(prisma, ISSUER, 'not.a.jwt')).toBeNull();
  });

  it('refuses a token signed by a key of the same id that is not the one on file', async () => {
    const key = generateSigningKey('ES256');
    const impostor = { ...generateSigningKey('ES256'), kid: key.kid };
    expect(await verifyAccessToken(keyTable(key).prisma, ISSUER, await mint(impostor))).toBeNull();
  });

  it('stops verifying a revoked key as soon as the key set is invalidated', async () => {
    const key = generateSigningKey('ES256');
    const { prisma, rows } = keyTable(key);
    const token = await mint(key);
    expect(await verifyAccessToken(prisma, ISSUER, token)).not.toBeNull();

    rows[0].status = 'revoked';
    // Still cached: this is the window `invalidateSigningKeys` closes.
    expect(await verifyAccessToken(prisma, ISSUER, token)).not.toBeNull();
    invalidateSigningKeys();
    expect(await verifyAccessToken(prisma, ISSUER, token)).toBeNull();
  });

  it('says who, and nothing more, for a token that cannot stand for its user', async () => {
    const key = generateSigningKey('ES256');
    // What `motherbase gen bearer-jwt` produces: a subject and the standard claims.
    const offline = await mint(key, { claims: {} });
    const inactive = await mint(key, { user: { ...ACTIVE, status: 'banned' } });

    const { prisma } = keyTable(key);
    expect(await verifyAccessToken(prisma, ISSUER, offline)).toEqual({ subject: 'u1', user: null, issuedMs: null });
    // Minted here, so still dated: a revocation applies to it like any other.
    expect(await verifyAccessToken(prisma, ISSUER, inactive)).toEqual({
      subject: 'u1',
      user: null,
      issuedMs: expect.any(Number),
    });
  });

  it('verifies nothing with a row whose algorithm is not the key\'s own', async () => {
    const key = generateSigningKey('ES256');
    const { prisma, rows } = keyTable(key);
    rows[0].alg = 'RS256';
    expect(await verifyAccessToken(prisma, ISSUER, await mint(key))).toBeNull();

    // Recorded before the column existed: the key itself says which one.
    rows[0].alg = null;
    invalidateSigningKeys();
    expect(await verifyAccessToken(prisma, ISSUER, await mint(key))).not.toBeNull();
  });
});

describe('revokeAccessTokens', () => {
  it('refuses what was minted up to the revocation, for that user only', () => {
    revokeAccessTokens('u1', 1000);
    expect(accessTokenAccepted('u1', 999)).toBe(false);
    // Minted in the same millisecond: cannot be told from one minted before.
    expect(accessTokenAccepted('u1', 1000)).toBe(false);
    expect(accessTokenAccepted('u1', 1001)).toBe(true);
    expect(accessTokenAccepted('u2', 999)).toBe(true);
  });

  it('refuses everybody when the user is unknown, and starts that way at boot', () => {
    __resetAccessTokensForTests(500);
    expect(accessTokenAccepted('u1', 500)).toBe(false);
    expect(accessTokenAccepted('u1', 501)).toBe(true);

    revokeAccessTokens(undefined, 2000);
    expect(accessTokenAccepted('u1', 1999)).toBe(false);
    expect(accessTokenAccepted('u2', 2001)).toBe(true);
  });

  it('forgets entries no live token can be older than, before giving up on the map', () => {
    for (let i = 0; i < 100_000; i++) revokeAccessTokens(`user-${i}`, 1000);
    // Every one of those tokens has expired by now: nothing is lost by dropping them.
    const later = 1000 + MAX_ACCESS_TOKEN_LIFETIME_MS + 1;
    revokeAccessTokens('one-more', later);
    expect(accessTokenAccepted('never-revoked', later - 5)).toBe(true);
    expect(accessTokenAccepted('one-more', later - 5)).toBe(false);
  });

  it('trades the per-user entries for one cutoff rather than growing without bound', () => {
    for (let i = 0; i < 100_000; i++) revokeAccessTokens(`user-${i}`, 1000);
    revokeAccessTokens('one-more', 3000);
    // Every earlier entry is still honoured, now by the cutoff for everybody.
    expect(accessTokenAccepted('user-42', 2999)).toBe(false);
    expect(accessTokenAccepted('never-revoked', 2999)).toBe(false);
    expect(accessTokenAccepted('user-42', 3001)).toBe(true);
  });

  it('knows the longest an access token can be configured to live', () => {
    expect(MAX_ACCESS_TOKEN_LIFETIME_MS).toBe(AUTH_TOKEN_EXPIRY_LIMITS.accessTokenExpMin.max * 60_000);
  });
});

describe('a request carrying an access token', () => {
  async function harness() {
    const key = generateSigningKey('ES256');
    const { prisma } = keyTable(key);
    const auth: any = { options: { baseURL: ISSUER }, api: { getSession: vi.fn(async () => null) } };
    return { key, prisma, auth, token: await mint(key) };
  }
  const bearer = (token: string): any => ({ headers: { authorization: `Bearer ${token}` } });

  it('is served from the token on the data plane: no session lookup, no user lookup', async () => {
    const { prisma, auth, token } = await harness();
    const req = bearer(token); const next = vi.fn();
    await makeOptionalAuthMiddleware(() => auth, prisma)(req, res(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeUndefined();
    expect(req.tokenUser).toEqual({ id: 'u1', role: 'ADMIN', email: 'a@b.c', isAnonymous: false });
    expect(auth.api.getSession).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    // The same caller a session for this user produces.
    expect(callerFor(req)).toEqual({ id: 'u1', role: 'ADMIN', email: 'a@b.c', isAnonymous: false, serviceRole: false });
  });

  it('still loads the row where a controller is handed req.user', async () => {
    const { prisma, auth, token } = await harness();
    const row = { ...ACTIVE };
    prisma.user.findUnique.mockResolvedValue(row);
    const req = bearer(token); const next = vi.fn();
    await makeAuthMiddleware(() => auth, prisma)(req, res(), next);

    expect(req.user).toBe(row);
    expect(req.tokenUser).toBeUndefined();
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('is a 401 once its user was revoked, on both middlewares, and never falls back to the row', async () => {
    const { prisma, auth, token } = await harness();
    prisma.user.findUnique.mockResolvedValue({ ...ACTIVE });
    revokeAccessTokens('u1');

    const optional = res();
    await makeOptionalAuthMiddleware(() => auth, prisma)(bearer(token), optional, vi.fn());
    expect(optional.status).toHaveBeenCalledWith(401);

    const hard = res();
    await makeAuthMiddleware(() => auth, prisma)(bearer(token), hard, vi.fn());
    expect(hard.status).toHaveBeenCalledWith(401);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a revoked token of an inactive account too, and offers neither to a third-party resolver', async () => {
    const { key, prisma, auth, token } = await harness();
    const inactive = await mint(key, { user: { ...ACTIVE, status: 'banned' } });
    const resolver = vi.fn(async () => ({ sub: 'u1', email: null, role: 'authenticated' as const, claims: {}, providerId: 'self' }));
    revokeAccessTokens('u1');

    for (const revoked of [token, inactive]) {
      const req = bearer(revoked); const r = res();
      await makeOptionalAuthMiddleware(() => auth, prisma, resolver)(req, r, vi.fn());
      expect(r.status).toHaveBeenCalledWith(401);
      expect(req.thirdParty).toBeUndefined();
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('loads the row for a token that only names its subject, and honours its status', async () => {
    const { key, prisma, auth } = await harness();
    const offline = await mint(key, { claims: {} });

    prisma.user.findUnique.mockResolvedValue({ ...ACTIVE });
    const active = bearer(offline);
    await makeOptionalAuthMiddleware(() => auth, prisma)(active, res(), vi.fn());
    expect(active.user).toMatchObject({ id: 'u1' });
    expect(active.tokenUser).toBeUndefined();

    prisma.user.findUnique.mockResolvedValue({ ...ACTIVE, status: 'banned' });
    const banned = bearer(offline);
    await makeOptionalAuthMiddleware(() => auth, prisma)(banned, res(), vi.fn());
    expect(banned.user).toBeUndefined();
  });

  it('leaves a JWT that is not ours to the third-party resolver', async () => {
    const { prisma, auth } = await harness();
    const foreign = await mint(generateSigningKey('ES256'), { issuer: 'https://clerk.example' });
    const resolver = vi.fn(async () => ({ sub: 'ext', email: null, role: 'authenticated' as const, claims: {}, providerId: 'clerk' }));
    const req = bearer(foreign);
    await makeOptionalAuthMiddleware(() => auth, prisma, resolver)(req, res(), vi.fn());

    expect(resolver).toHaveBeenCalledWith(foreign);
    expect(req.thirdParty).toMatchObject({ sub: 'ext' });
    expect(req.tokenUser).toBeUndefined();
  });

  it('names the caller for the socket handshake and the rate limiter', async () => {
    const { prisma, auth, token } = await harness();
    const identityOf = makeIdentityResolver(() => auth, prisma);

    expect(await identityOf({ authorization: `Bearer ${token}` })).toEqual({ id: 'u1', role: 'ADMIN' });
    expect(await identityOf({})).toBeNull();

    // A session for an account that is no longer active names nobody.
    auth.api.getSession.mockResolvedValue({ user: { id: 'u1' } });
    prisma.user.findUnique.mockResolvedValue({ ...ACTIVE, status: 'banned' });
    expect(await identityOf({ cookie: 'better-auth.session_token=t' })).toBeNull();
  });
});
