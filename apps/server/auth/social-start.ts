import type { Request, Response } from 'express';

/**
 * Top-level-navigation entry point for social sign-in.
 *
 * Better Auth only exposes `POST /sign-in/social`, so a browser app has to
 * start the flow with an XHR. For an app on another site that is fatal: the
 * OAuth state cookie arrives on a cross-site response, which Safari and
 * Firefox refuse outright and Chrome refuses in incognito, and the provider
 * callback then fails with `state_mismatch`. `SameSite=None` only helps the
 * browsers that still allow third-party cookies at all.
 *
 * Navigating the browser here instead makes the whole handshake first-party:
 * the state cookie is written during a top-level navigation to this API's own
 * origin, and the provider callback is another top-level navigation back to
 * it, so a plain `SameSite=Lax` cookie survives in every browser.
 *
 *   window.location.href =
 *     'https://api.example.com/api/auth/sign-in/social/google' +
 *     '?callbackURL=https://app.example.com/auth/callback';
 *
 * The session still reaches the app through the token fragment the callback
 * appends (see ./oauth-redirect.ts).
 */

/** The minimum this route needs from the live Better Auth instance. */
export interface SocialStartAuth {
  api: {
    signInSocial: (input: {
      body: {
        provider: string;
        disableRedirect?: boolean;
        callbackURL?: string;
        errorCallbackURL?: string;
        newUserCallbackURL?: string;
        scopes?: string[];
      };
      returnHeaders: true;
    }) => Promise<{ headers: Headers; response: unknown }>;
  };
  $context: Promise<{
    isTrustedOrigin: (url: string, settings?: { allowRelativePaths: boolean }) => boolean;
  }>;
}

/**
 * `originCheckMiddleware` returns early for GET, so Better Auth does NOT
 * validate a callbackURL that arrives in the query string. Without this check
 * the route would be an open redirect that also hands the session token in the
 * fragment to whatever host the attacker names.
 */
export function invalidRedirectTarget(
  urls: (string | undefined)[],
  isTrustedOrigin: (url: string, settings?: { allowRelativePaths: boolean }) => boolean,
): string | null {
  for (const url of urls) {
    if (url === undefined) continue;
    if (typeof url !== 'string' || !url) return 'Invalid callback URL';
    if (!isTrustedOrigin(url, { allowRelativePaths: true })) return `Untrusted callback URL: ${url}`;
  }
  return null;
}

/** Reads a query parameter, rejecting the repeated-key array form. */
function singleQueryValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : '';
}

const MAX_SCOPES = 20;
const MAX_SCOPE_LENGTH = 200;
// Printable ASCII only: scopes are opaque provider tokens (URLs, `a.b/c`, `a:b`).
const SCOPE_CHARS = /^[\x21-\x7e]+$/;

/**
 * Parses the `scopes` query parameter (space or comma separated) into the array
 * Better Auth takes. Returns `null` when it is malformed, so the caller can 400
 * rather than forward something a provider would reject mid-redirect.
 */
export function parseScopes(raw: string | undefined): string[] | null {
  const scopes = (raw ?? '').split(/[\s,]+/).filter(Boolean);
  if (scopes.length > MAX_SCOPES) return null;
  if (!scopes.every(s => s.length <= MAX_SCOPE_LENGTH && SCOPE_CHARS.test(s))) return null;
  return scopes;
}

export function createSocialStartHandler(resolveAuth: () => SocialStartAuth | Promise<SocialStartAuth>) {
  return async function socialStart(req: Request, res: Response): Promise<void> {
    const provider = String(req.params.provider ?? '');
    if (!provider) {
      res.status(400).json({ error: 'Missing provider' });
      return;
    }

    const scopes = parseScopes(singleQueryValue(req.query.scopes));
    if (!scopes) {
      res.status(400).json({ error: 'Invalid scopes' });
      return;
    }

    const auth = await resolveAuth();
    const callbackURL = singleQueryValue(req.query.callbackURL);
    const errorCallbackURL = singleQueryValue(req.query.errorCallbackURL);
    const newUserCallbackURL = singleQueryValue(req.query.newUserCallbackURL);

    // Bound, not destructured: Better Auth's `isTrustedOrigin` is a method that
    // reads `this.trustedOrigins`, so a bare reference throws
    // `Cannot read properties of undefined (reading 'trustedOrigins')`.
    const ctx = await auth.$context;
    const rejection = invalidRedirectTarget(
      [callbackURL, errorCallbackURL, newUserCallbackURL],
      (url, settings) => ctx.isTrustedOrigin(url, settings),
    );
    if (rejection) {
      res.status(403).json({ error: rejection });
      return;
    }

    const result = await auth.api.signInSocial({
      body: {
        provider,
        disableRedirect: true,
        ...(callbackURL ? { callbackURL } : {}),
        ...(errorCallbackURL ? { errorCallbackURL } : {}),
        ...(newUserCallbackURL ? { newUserCallbackURL } : {}),
        ...(scopes.length ? { scopes } : {}),
      },
      returnHeaders: true,
    });

    // The state cookie Better Auth just minted lives on these headers. Copy it
    // across before redirecting, or the callback has nothing to check against.
    const setCookie = result.headers?.getSetCookie?.() ?? [];
    if (setCookie.length) res.setHeader('set-cookie', setCookie);

    const url = (result.response as { url?: string } | null)?.url;
    if (!url) {
      res.status(502).json({ error: `Provider ${provider} did not return an authorization URL` });
      return;
    }
    res.redirect(302, url);
  };
}
