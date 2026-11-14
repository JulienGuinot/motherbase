import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { IncomingHttpHeaders } from 'http';
import { fromNodeHeaders } from 'better-auth/node';
import type { PrismaClient, User } from '@prisma/client';
import { HttpException } from '../exceptions/http-exception';
import { apiErrorEnvelope } from '../middlewares/api-error.middleware';
import type { AuthInstance } from './instance';
import type { ThirdPartyCaller } from './third-party';
import { readSession } from './server-session';
import { accessTokenAccepted, verifyAccessToken, type AccessTokenUser } from './access-tokens';
// Declares `req.tokenUser`, which the optional middleware below sets.
import './signed-in-user';

// Project-side auth middleware. A request names its caller one of two ways:
//
//   * a Better Auth session (cookie, or the session token as a bearer). The
//     session is looked up, then the full Prisma user is RELOADED by id, so
//     `req.user` is exactly the Prisma `User` every controller expects and
//     role/status are live. A soft-deleted or deactivated account
//     (status !== 'active') is rejected with 403.
//   * an access token (the JWT from /api/auth/token) as a bearer. It is
//     verified against the signing keys in memory. The data plane then takes
//     the caller from its claims, on `req.tokenUser`, with no query at all;
//     the routes behind the hard middleware still reload the row. How a token
//     stops being honoured before it expires is in auth/access-tokens.ts.

// A getter so the middleware always uses the live instance. The AuthManager may
// swap it in-process when auth settings change in the console.
type GetAuth = () => AuthInstance | Promise<AuthInstance>;

/** `Authorization: Bearer <a.b.c>`: the shape of a JWT, not of a session token. */
export function bearerJwt(header: string | undefined): string | null {
  const token = /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];
  return token && token.split('.').length === 3 ? token : null;
}

/**
 * Whether the request carries anything Better Auth could turn into a session: a
 * cookie (session token, cookie cache, anonymous user), a bearer, or the user
 * API-key header. Without one, getSession can only answer null, and asking it
 * builds a full Better Auth endpoint context, which profiled at ~9% of the CPU
 * of an anonymous REST read.
 */
export function carriesCredentials(headers: Request['headers']): boolean {
  return Boolean(headers.cookie || headers.authorization || headers['x-api-key']);
}

/** Who a request's credentials name. At most one of `user` and `tokenUser` is set. */
interface ResolvedCaller {
  /** The full row, read from the database for this request. */
  user?: User | null;
  /** The caller as a verified access token describes it. */
  tokenUser?: AccessTokenUser;
  /** The bearer is an access token of ours that was revoked: it names nobody, to anyone. */
  refused?: true;
}

const NOBODY: ResolvedCaller = { user: null };
const REFUSED: ResolvedCaller = { user: null, refused: true };

/**
 * `fromToken` lets a verified access token stand for the caller on its own.
 * Without it the token only says which row to load, which is what a route that
 * hands `req.user` to a controller needs.
 */
async function resolveCaller(
  getAuth: GetAuth,
  prisma: PrismaClient,
  headers: IncomingHttpHeaders,
  { fromToken }: { fromToken: boolean },
): Promise<ResolvedCaller> {
  if (!carriesCredentials(headers)) return NOBODY;
  const auth = await getAuth();

  // An access token from /api/auth/token (or one minted with `motherbase gen
  // bearer-jwt` from an imported signing key), checked first because it costs
  // no query: a session token has two segments, never three, so this cannot
  // mistake one for the other. A JWT that is not ours (a third-party issuer's)
  // falls through; the optional middleware tries it as one.
  const jwt = bearerJwt(headers.authorization);
  const token = jwt ? await verifyAccessToken(prisma, auth.options.baseURL, jwt) : null;
  if (token) {
    // Minted before its session ended or its user changed: refused, exactly
    // like a session that no longer exists. Falling back to the row here
    // would bring a revoked session's token back to life.
    if (token.issuedMs !== null && !accessTokenAccepted(token.subject, token.issuedMs)) return REFUSED;
    if (token.user && fromToken) return { tokenUser: token.user };
    return { user: await prisma.user.findUnique({ where: { id: token.subject } }) };
  }

  const session = await readSession(auth, fromNodeHeaders(headers));
  const id = session?.user?.id;
  if (!id) return NOBODY;
  return { user: await prisma.user.findUnique({ where: { id: String(id) } }) };
}

/**
 * The caller behind a set of headers, for code that is not an Express
 * middleware (the socket handshake, the rate-limit identity): its id and role,
 * or null for anyone not signed in or whose account is not active.
 */
export function makeIdentityResolver(getAuth: GetAuth, prisma: PrismaClient) {
  return async (headers: IncomingHttpHeaders): Promise<{ id: string; role: string } | null> => {
    const { user, tokenUser } = await resolveCaller(getAuth, prisma, headers, { fromToken: true });
    if (tokenUser) return { id: tokenUser.id, role: tokenUser.role };
    return user && user.status === 'active' ? { id: user.id, role: String(user.role) } : null;
  };
}

/** Hard auth: 401 without a valid session, 403 for an inactive account. */
export function makeAuthMiddleware(getAuth: GetAuth, prisma: PrismaClient): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user } = await resolveCaller(getAuth, prisma, req.headers, { fromToken: false });
      if (!user) return res.status(401).json(apiErrorEnvelope('UNAUTHORIZED', 'A valid user session is required.', req.id));
      if (user.status !== 'active') throw new HttpException('Account is not active', 403);
      (req as any).user = user;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/** Resolves a bearer JWT from a configured third-party issuer; null = not one. Throws when it fails to verify. */
export type ThirdPartyResolver = (token: string) => Promise<ThirdPartyCaller | null>;

/** `Authorization: Bearer <token>` holding the end user's token rather than a project key. */
function hasUserBearer(header: string | undefined): boolean {
  const token = /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];
  return Boolean(token && !token.startsWith('mb_'));
}

/**
 * Optional auth: enriches req.user when a valid session is present, and lets a
 * caller with no token through as anonymous.
 *
 * A token that names no session (expired, revoked, signed with a rotated
 * secret) is a 401, as an invalid project key is in apiKeyMiddleware. Downgraded
 * to anonymous, it read as empty rows and RLS refusals: the app kept showing a
 * signed-in user, and the SDK, which revalidates the session on a 401, never
 * learnt it was dead. `allowUnknownBearer` keeps the old fall-through for edge
 * functions, whose public ones may check a bearer of their own.
 *
 * An account that exists but is inactive, or a lookup that throws, still
 * proceeds as anonymous: neither says the token is dead.
 *
 * With `resolveThirdParty`, a bearer that is no Better Auth session is tried as
 * a Clerk / Firebase / Auth0 / Cognito / WorkOS JWT (Supabase Third-Party
 * Auth) and lands on `req.thirdParty`. Only this optional middleware does it:
 * it fronts the data plane, and a third-party caller has no user row for the
 * hard one to load. One that claims a configured issuer and fails to verify is
 * a 401 rather than a silent anon, so a clock or key problem is visible.
 */
export function makeOptionalAuthMiddleware(
  getAuth: GetAuth,
  prisma: PrismaClient,
  resolveThirdParty?: ThirdPartyResolver,
  { allowUnknownBearer = false }: { allowUnknownBearer?: boolean } = {},
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    let unknownSession = false;
    let refused = false;
    try {
      const { user, tokenUser, ...caller } = await resolveCaller(getAuth, prisma, req.headers, { fromToken: true });
      refused = caller.refused === true;
      unknownSession = !user && !tokenUser;
      if (tokenUser) req.tokenUser = tokenUser;
      else if (user && user.status === 'active') req.user = user;
    } catch {
      /* proceed as anonymous rather than crashing the request */
    }
    // Only a JWT can be a third-party token: an API key sent as a bearer
    // (`Authorization: Bearer mb_secret_...`) never reaches the resolver. Nor
    // does a revoked token of ours: a provider entry pointing back at this
    // project's own keys must not be a way around its revocation.
    const bearer = !req.user && !req.tokenUser && !refused && resolveThirdParty ? bearerJwt(req.headers.authorization) : null;
    if (bearer) {
      try {
        const caller = await resolveThirdParty!(bearer);
        if (caller) req.thirdParty = caller;
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : 'invalid token';
        return res.status(401).json(apiErrorEnvelope('UNAUTHORIZED', `Third-party token rejected: ${reason}`, req.id));
      }
    }
    if (unknownSession && !req.thirdParty && !allowUnknownBearer && hasUserBearer(req.headers.authorization)) {
      return res.status(401).json(apiErrorEnvelope('UNAUTHORIZED', 'The session is expired or was revoked. Sign in again.', req.id));
    }
    return next();
  };
}
