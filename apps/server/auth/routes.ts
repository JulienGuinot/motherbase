import type { Application, RequestHandler } from 'express';
import { HTTP_ROUTES } from '@motherbase/contracts';
import { attachOAuthTokenToRedirect, isOAuthCallbackPath } from './oauth-redirect';
import { createSocialStartHandler, type SocialStartAuth } from './social-start';
import { createPkceCodec } from './pkce';

export type AuthHandlerResolver = () => RequestHandler | Promise<RequestHandler>;

/** Reads the session cookie name off the live auth instance. */
export type SessionCookieNameResolver = () => string | Promise<string>;

/**
 * Mount the project auth transport without coupling tests or app bootstrap to a
 * concrete Better Auth instance. The resolved handler remains the sole owner
 * of Better Auth request/response formats.
 */
export function registerProjectAuthRoutes(
  app: Pick<Application, 'all' | 'get'>,
  resolveHandler: AuthHandlerResolver,
  limiter: RequestHandler,
  resolveSessionCookieName?: SessionCookieNameResolver,
  resolveAuth?: () => SocialStartAuth | Promise<SocialStartAuth>,
  /** The auth secret PKCE codes are sealed with; absent = implicit flow only. */
  resolvePkceSecret?: () => string | Promise<string>,
): void {
  // Registered ahead of the catch-all: Better Auth's own router only answers
  // POST here, and a browser has to reach this by navigation, not by fetch.
  if (resolveAuth) {
    const socialStart = createSocialStartHandler(resolveAuth);
    app.get(`${HTTP_ROUTES.auth}/sign-in/social/:provider`, limiter, (req, res, next) => {
      socialStart(req, res).catch(next);
    });
  }

  app.all(`${HTTP_ROUTES.auth}/*`, limiter, async (req, res, next) => {
    // Project-key administration is served by our controllers after body parsing.
    if (req.path === HTTP_ROUTES.authAdmin || req.path.startsWith(`${HTTP_ROUTES.authAdmin}/`)) return next();
    try {
      // A provider callback answers with a redirect and an httpOnly cookie, which
      // a frontend on another origin cannot read. Add the token to the redirect
      // fragment so the SDK can finish the sign-in (see ./oauth-redirect.ts).
      if (resolveSessionCookieName && isOAuthCallbackPath(req.path)) {
        const pkce = resolvePkceSecret ? createPkceCodec(await resolvePkceSecret()) : undefined;
        attachOAuthTokenToRedirect(res, await resolveSessionCookieName(), pkce);
      }
      const handler = await resolveHandler();
      // Awaited so a rejection lands in the catch: Express 4 ignores the
      // promise an async handler returns, so an un-awaited one leaves the
      // request hanging with no response, and the error in unhandledRejection.
      return await handler(req, res, next);
    } catch (error: unknown) {
      return next(error);
    }
  });
}
