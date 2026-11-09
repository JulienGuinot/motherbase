import { HTTP_ROUTES } from "@motherbase/contracts";
import { AuthAdminActions, SocialSignInBody } from "./types.js";
import { HttpClient } from "../http/index.js";
import { withoutTrailingSlash } from "../http/utils.js";
import { AuthAdminClient } from "../admin/auth-admin-client.js";

/** The server's GET start route for a social sign-in (auth/social-start.ts). */
export function socialStartUrl(projectUrl: string, body: SocialSignInBody): string {
  const params = new URLSearchParams();
  for (const key of ['callbackURL', 'errorCallbackURL', 'newUserCallbackURL'] as const) {
    if (body[key]) params.set(key, body[key]);
  }
  if (body.scopes?.length) params.set('scopes', body.scopes.join(' '));
  const query = params.toString();
  const provider = encodeURIComponent(body.provider ?? '');
  return `${withoutTrailingSlash(projectUrl)}${HTTP_ROUTES.authSignInSocial}/${provider}${query ? `?${query}` : ''}`;
}

/** The `token` a `/revoke-session` request names. The body reaches the hook serialized. */
export function revokedToken(body: unknown): string | undefined {
  try {
    return (typeof body === 'string' ? JSON.parse(body) : body)?.token;
  } catch {
    return undefined;
  }
}

/**
 * Read the token an OAuth callback left in the URL fragment and return the URL
 * with it removed, so a reload or a shared link cannot replay it.
 *
 * The provider callback cannot answer the SDK with a JSON body: it is a browser
 * redirect. The server therefore appends `#access_token=…` to the redirect it
 * issues (auth/oauth-redirect.ts). Exported for testing.
 */
export function readAccessTokenFromUrl(href: string): { accessToken: string; cleanedHref: string } | null {
  const hash = href.indexOf('#');
  if (hash === -1) return null;
  const params = new URLSearchParams(href.slice(hash + 1));
  const accessToken = params.get('access_token');
  if (!accessToken) return null;
  params.delete('access_token');
  params.delete('token_type');
  const rest = params.toString();
  return { accessToken, cleanedHref: `${href.slice(0, hash)}${rest ? `#${rest}` : ''}` };
}



/** The auth path of a request: `/api/auth/sign-in/email` → `/sign-in/email`. */
export function authPath(url: string | URL): string {
  const pathname = typeof url === 'string' && !/^https?:/.test(url) ? url.split('?')[0] : new URL(url).pathname;
  return pathname.startsWith(HTTP_ROUTES.auth) ? pathname.slice(HTTP_ROUTES.auth.length) : pathname;
}

/**
 * The proxy hands out the function it finds detached from its object, so a
 * class instance exposed as an action would lose `this`. Copy its methods out
 * bound.
 */
export function bindMethods<T extends object>(target: T): Omit<T, never> {
  const bound: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(target))) {
    const value = (target as Record<string, unknown>)[key];
    if (key !== 'constructor' && typeof value === 'function') bound[key] = value.bind(target);
  }
  return bound as Omit<T, never>;
}






export function adminActions(http: HttpClient): AuthAdminActions {
  const admin = new AuthAdminClient(http);
  return { ...bindMethods(admin), mfa: bindMethods(admin.mfa) };
}