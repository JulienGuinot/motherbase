/**
 * Hands the freshly created session to the frontend after a provider callback.
 *
 * Better Auth finishes an OAuth sign-in by setting the session cookie and
 * redirecting to `callbackURL`. A frontend served from another origin than the
 * API can never read that cookie (it is httpOnly, and cross-site it is not even
 * sent), so `signInWithOAuth` started a flow that could not produce a session in
 * the SDK at all: the browser came back signed in as far as the API was
 * concerned and the client store stayed empty. Supabase solves this with the
 * implicit flow, and so do we: the token rides back in the URL fragment, which
 * browsers never send to a server and which the SDK strips once it has read it.
 *
 * The token is the session cookie's value, which is exactly what the bearer
 * plugin accepts in `Authorization: Bearer …`. A flow started with PKCE gets a
 * `?code=` for `exchangeCodeForSession` instead (see ./pkce.ts).
 */

import { pkceChallengeOf, type PkceCodec } from './pkce';
import { PKCE_PARAMS } from './redirect-urls';

/**
 * Better Auth mounts social and generic OAuth callbacks at /callback/:id and
 * SSO at /sso/callback/:id (/sso/saml2/callback/:id for SAML), all under its
 * /api/auth base path. A magic link lands
 * on /magic-link/verify, which ends the same way: a session cookie and a
 * redirect a cross-origin frontend cannot read the cookie of. Matched against
 * the express path, so the query string is not part of it.
 */
const CALLBACK_PATH = /\/api\/auth\/(?:(?:sso\/|sso\/saml2\/)?callback\/[^/]+|magic-link\/verify)$/;

export function isOAuthCallbackPath(path: string): boolean {
  return CALLBACK_PATH.test(path);
}

/**
 * Wrap `res.writeHead` so the redirect the auth handler is about to send picks
 * up the session token. Runs at writeHead time because that is the first moment
 * both the `Location` and the `Set-Cookie` the handler produced are known.
 */
export function attachOAuthTokenToRedirect(res: {
  writeHead: (...args: never[]) => unknown;
  getHeader: (name: string) => number | string | string[] | undefined;
  setHeader: (name: string, value: string) => unknown;
}, sessionCookieName: string, pkce?: PkceCodec): void {
  const original = res.writeHead.bind(res) as (...args: unknown[]) => unknown;
  res.writeHead = ((...args: unknown[]) => {
    try {
      const location = res.getHeader('location');
      const setCookie = res.getHeader('set-cookie');
      if (typeof location === 'string' && setCookie !== undefined) {
        const token = sessionTokenFromSetCookie(setCookie, sessionCookieName);
        // A redirect that carries a code_challenge started a PKCE flow: it gets
        // a code only its verifier can redeem, never the token itself.
        const challenge = pkce ? pkceChallengeOf(location) : null;
        if (token && challenge && pkce) {
          res.setHeader('location', withAuthCode(location, pkce.mint(token, challenge.challenge, challenge.method)));
        } else if (token) {
          res.setHeader('location', withAccessTokenFragment(location, token));
        }
      }
    } catch {
      /* a failed rewrite must still let the redirect through */
    }
    return original(...args);
  }) as typeof res.writeHead;
}

/**
 * Pull the session token out of the response's `Set-Cookie`. Node keeps the
 * cookies as separate array entries, so there is no comma-splitting to get
 * wrong. A `Max-Age=0` entry is the sign-out cookie, not a new session.
 */
export function sessionTokenFromSetCookie(
  setCookie: number | string | string[],
  name: string,
): string | null {
  for (const raw of Array.isArray(setCookie) ? setCookie : [String(setCookie)]) {
    const [pair, ...attrs] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq === -1 || pair.slice(0, eq).trim() !== name) continue;
    if (attrs.some(a => /^\s*max-age\s*=\s*0\s*$/i.test(a))) continue;
    const value = pair.slice(eq + 1).trim();
    if (value) return decodeURIComponent(value);
  }
  return null;
}

/**
 * Append `#access_token=…` to the redirect the callback is about to issue.
 * Keeps any fragment the caller's `redirectTo` already had, and leaves a
 * location that already carries a token untouched.
 */
export function withAccessTokenFragment(location: string, token: string): string {
  if (!token) return location;
  const hash = location.indexOf('#');
  const base = hash === -1 ? location : location.slice(0, hash);
  const params = new URLSearchParams(hash === -1 ? '' : location.slice(hash + 1));
  if (params.has('access_token')) return location;
  params.set('access_token', token);
  params.set('token_type', 'bearer');
  return `${base}#${params.toString()}`;
}

/**
 * Replace the PKCE parameters on the redirect with `?code=…`, where supabase-js
 * looks for it. Built by hand rather than through URL so a relative or
 * custom-scheme location comes back exactly as it went in.
 */
export function withAuthCode(location: string, code: string): string {
  const hash = location.indexOf('#');
  const fragment = hash === -1 ? '' : location.slice(hash);
  const beforeHash = hash === -1 ? location : location.slice(0, hash);
  const q = beforeHash.indexOf('?');
  const path = q === -1 ? beforeHash : beforeHash.slice(0, q);
  const params = new URLSearchParams(q === -1 ? '' : beforeHash.slice(q + 1));
  for (const param of PKCE_PARAMS) params.delete(param);
  params.set('code', code);
  return `${path}?${params.toString()}${fragment}`;
}
