import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import type { PrismaClient } from '@prisma/client';
import { HttpException } from '../exceptions/http-exception';
import { apiErrorEnvelope } from '../middlewares/api-error.middleware';
import type { AuthInstance } from './instance';
import type { ThirdPartyCaller } from './third-party';

// Project-side auth middleware over Better Auth sessions. It verifies the
// session (cookie or bearer/JWT), then RELOADS the full Prisma user by id so
// `req.user` is exactly the Prisma `User` every controller already expects. And
// so role/status are always live, never trusted from the token. A soft-deleted
// or deactivated account (status !== 'active') is rejected with 403.

// A getter so the middleware always uses the live instance. The AuthManager may
// swap it in-process when auth settings change in the console.
type GetAuth = () => AuthInstance | Promise<AuthInstance>;

/** `Authorization: Bearer <a.b.c>`: the shape of a JWT, not of a session token. */
export function bearerJwt(header: string | undefined): string | null {
  const token = /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];
  return token && token.split('.').length === 3 ? token : null;
}

// The jwt plugin is always registered (auth/instance.ts), but the plugin list is
// assembled conditionally, which erases its endpoints from the inferred API type.
type JwtApi = {
  verifyJWT(input: { body: { token: string } }): Promise<{ payload: { sub?: unknown } | null }>;
};

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

async function resolveUser(getAuth: GetAuth, prisma: PrismaClient, req: Request) {
  if (!carriesCredentials(req.headers)) return null;
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  let id = session?.user?.id;
  // An access token from /api/auth/token (or one minted with `motherbase gen
  // bearer-jwt` from an imported signing key). Better Auth verifies it against
  // every key not revoked, with this project as issuer and audience. Only the
  // subject is taken from it: role and status are reloaded below like any session.
  const jwt = !id ? bearerJwt(req.headers.authorization) : null;
  if (jwt) {
    const verified = await (auth.api as unknown as JwtApi).verifyJWT({ body: { token: jwt } }).catch(() => null);
    id = typeof verified?.payload?.sub === 'string' ? verified.payload.sub : undefined;
  }
  if (!id) return null;
  return prisma.user.findUnique({ where: { id: String(id) } });
}

/** Hard auth: 401 without a valid session, 403 for an inactive account. */
export function makeAuthMiddleware(getAuth: GetAuth, prisma: PrismaClient): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await resolveUser(getAuth, prisma, req);
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
    try {
      const user = await resolveUser(getAuth, prisma, req);
      unknownSession = user === null;
      if (user && user.status === 'active') (req as any).user = user;
    } catch {
      /* proceed as anonymous rather than crashing the request */
    }
    // Only a JWT can be a third-party token: an API key sent as a bearer
    // (`Authorization: Bearer mb_secret_...`) never reaches the resolver.
    const bearer = !req.user && resolveThirdParty ? bearerJwt(req.headers.authorization) : null;
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
