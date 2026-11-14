import type { Request } from 'express';
import type { AccessTokenUser } from './access-tokens';

// A leaf module on purpose: rate limiting, logging and telemetry all ask who
// the caller is, and none of them should have to import the auth middleware
// (and everything it imports) to find out.

declare global {
  namespace Express {
    interface Request {
      /**
       * Set by the optional auth middleware when the caller presented a valid
       * access token: who they are, as the token says it. Never set together
       * with `user`. Read the caller through `signedInUser` or `callerFor`
       * rather than through either field, so both kinds are honoured.
       */
      tokenUser?: AccessTokenUser;
    }
  }
}

/** The signed-in caller of a request, whichever way it authenticated. */
export function signedInUser(req: Request): { id: string; role: string } | undefined {
  return req.user ?? req.tokenUser;
}
