import { BetterFetchOption, BetterFetchPlugin } from "@better-fetch/fetch";
import { COOKIE_PATHS, REDIRECT_SIGN_IN_PATHS, SIGN_OUT_PATHS, USER_CHANGE_PATHS } from "./constants.js";
import { SessionStore } from "./session.js";
import type { AuthClientOptions, AuthPayload, SessionResult, SocialSignInBody, User } from "./types.js";
import { authPath, revokedToken, socialStartUrl } from "./utils.js";
import { normalizeUser } from "../utils/compat.js";
import { isBrowser } from "../utils/runtime.js";
import { pkceCallback } from "./pkce.js";

/**
 * The session a successful auth response carries, if any.
 *
 * Better Auth answers a sign-in with `{ token, user }` (password, OTP, anonymous,
 * id token, second factor) or `{ session: { token }, user }` (passkey,
 * get-session). A `user` is required alongside: the jwt plugin's `/token`
 * answers `{ token }` with a JWT, which is not a session.
 */
export function sessionFromResponse(data: unknown): AuthPayload | null {
  if (!data || typeof data !== 'object') return null;
  const body = data as { token?: unknown; session?: { token?: unknown } | null; user?: User | null };
  if (!body.user) return null;
  const token = typeof body.token === 'string' ? body.token : body.session?.token;
  return typeof token === 'string' ? { token, user: body.user } : null;
}

/**
 * Whether two tokens name the same session. The bearer the server hands out
 * (`set-auth-token`, the OAuth fragment) is the signed cookie value,
 * `<token>.<signature>`, while response bodies carry the bare `<token>`; the
 * bearer plugin accepts either.
 */ 
export function sameSession(stored: string | undefined, token: string | undefined): boolean {
  if (!stored || !token) return false;
  return stored === token || stored.startsWith(`${token}.`) || token.startsWith(`${stored}.`);
}


export function currentSession(store: SessionStore): SessionResult | null {
  const session = store.get();
  return session ? { data: { user: session.user, session }, error: null } : null;
}


/**
 * Keeps the SDK's session store and Better Auth's calls in step: the bearer
 * goes out on every request, and every response that creates, replaces or ends
 * the session is written back, which is what fires `onAuthStateChange`.
 */
export function sessionSync(
  store: SessionStore,
  options: AuthClientOptions,
  /** Reads the session again; its response comes back through this plugin. */
  revalidate: () => Promise<unknown>,
): BetterFetchPlugin {
  const { flowType, verifiers } = options;
  const revisions = new WeakMap<object, number>();
  return {
    id: 'motherbase-session',
    name: 'Motherbase session',
    // Edits the call's options in place rather than returning a copy: better-fetch
    // runs its own schema plugin after this one, and it hands back the options
    // object it was given. The object is built fresh for every call.
    async init(url, fetchOptions: BetterFetchOption = {}) {
      const path = authPath(url);
      fetchOptions.credentials = COOKIE_PATHS.some(prefix => path.startsWith(prefix)) ? 'include' : 'same-origin';

      // Node does not send Origin, and Better Auth's CSRF check wants one on a
      // mutation. Supply the project's own rather than turning the check off.
      const headers = (fetchOptions.headers ?? {}) as Record<string, string>;
      if (!isBrowser() && (fetchOptions.method ?? 'GET').toUpperCase() !== 'GET'
        && !Object.keys(headers).some(name => name.toLowerCase() === 'origin')) {
        fetchOptions.headers = { ...headers, origin: new URL(options.url).origin };
      }

      const body = (fetchOptions.body ?? {}) as SocialSignInBody;
      // An id-token sign-in answers with the session directly: no redirect.
      if (!REDIRECT_SIGN_IN_PATHS.includes(path) || body.idToken) return { url, options: fetchOptions };

      if (flowType === 'pkce') {
        fetchOptions.body = { ...body, callbackURL: await pkceCallback(body.callbackURL, verifiers) };
      }
      if (path === '/sign-in/social' && isBrowser() && !body.disableRedirect) {
        // Started with a fetch, the OAuth state cookie is a cross-site write
        // that Safari and Firefox drop (Chrome too, in incognito), and the
        // callback fails with state_mismatch. Navigating to the server's GET
        // start route makes it first-party. The request is answered locally
        // with Better Auth's own shape, `redirect: false` so it does not
        // navigate a second time.
        const href = socialStartUrl(options.url, fetchOptions.body as SocialSignInBody);
        window.location.href = href;
        fetchOptions.customFetchImpl = async () => Response.json({ url: href, redirect: false });
      }
      return { url, options: fetchOptions };
    },
    hooks: {
      onRequest(request) {
        revisions.set(request, store.getRevision());
      },
      async onSuccess({ data, request }) {
        const path = authPath(request.url);
        const current = store.get();
        // Do not let an older response replace a newer account or sign-out.
        if (revisions.get(request) !== store.getRevision()) return;
        const ended = SIGN_OUT_PATHS.has(path)
          || (path === '/revoke-session' && sameSession(current?.accessToken, revokedToken(request.body)))
          || (path === '/delete-user' && (data as { message?: string } | null)?.message === 'User deleted')
          // The stored token was revoked or expired elsewhere: the server answers
          // null. Only for the stored token: getSessionFromUrl checks another one.
          || (path === '/get-session' && data === null
            && request.headers.get('authorization') === `Bearer ${current?.accessToken}`);
        if (ended) {
          await store.set(null, 'signOut');
          return;
        }
        if (USER_CHANGE_PATHS.has(path) && current) {
          await revalidate();
          return;
        }

        const next = sessionFromResponse(data);
        if (!next) return;
        if (!current || !sameSession(current.accessToken, next.token)) {
          await store.set({ accessToken: next.token, user: next.user }, path.startsWith('/two-factor/') ? 'mfaVerified' : 'signIn');
        } else if (JSON.stringify(normalizeUser(next.user)) !== JSON.stringify(current.user)) {
          // Compared as the store holds it: normalised, aliases included.
          await store.set({ ...current, user: next.user }, 'userUpdated');
        }
      },
    },
  };
}
