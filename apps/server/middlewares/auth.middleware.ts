import prisma from '../lib/prisma';
import container from '../container';
import { makeAuthMiddleware, makeOptionalAuthMiddleware } from '../auth/session';

// Project-side auth runs on Better Auth. These preserve the export names the
// controllers already use via `@before([authMiddleware])`, so no controller
// changes are needed. Both validate a Better Auth session (cookie or bearer/JWT)
// and reload the full Prisma user onto req.user (see auth/session.ts). The auth
// instance is resolved live from AuthManager so console config changes apply
// without a restart.

const getAuth = () => container.resolve('AuthManager').current();

export const authMiddleware = makeAuthMiddleware(getAuth, prisma);
const verifyThirdParty = (token: string) => container.resolve('ThirdPartyAuthService').verify(token);

export const optionalAuthMiddleware = makeOptionalAuthMiddleware(getAuth, prisma, verifyThirdParty);

// A public edge function may authenticate its callers with a bearer of its own
// (a cron secret, a webhook token), which is no session and must not be refused.
export const edgeOptionalAuthMiddleware = makeOptionalAuthMiddleware(getAuth, prisma, verifyThirdParty, {
  allowUnknownBearer: true,
});
