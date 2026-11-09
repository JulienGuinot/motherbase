import { HttpClient } from "../http/index.js";
import { SessionStore } from "./session.js";
import { isBrowser } from "../utils/runtime.js";
import { EVENT_MAP } from "./constants.js";
import {  AuthClientOptions, MotherbaseClientPlugin } from "./types.js";
import { adminActions, readAccessTokenFromUrl } from "./utils.js";
import { currentSession, sameSession, sessionFromResponse, sessionSync } from "./session-utils.js";



/** Motherbase's additions, as a Better Auth client plugin. */
export function motherbaseClient(http: HttpClient, store: SessionStore, options: AuthClientOptions): MotherbaseClientPlugin {
  // Bound when Better Auth hands over its fetch, which happens as the client
  // is built, before any request can reach the session sync.
  let revalidate: () => Promise<unknown> = async () => undefined;
  return {
    id: 'motherbase',
    fetchPlugins: [sessionSync(store, options, () => revalidate())],
    getActions: $fetch => {
      revalidate = () => $fetch('/get-session');
      return {
        onAuthStateChange(callback) {
          let active = true;
          const unsubscribe = store.subscribe((event, session) => {
            if (active) callback(EVENT_MAP[event], session);
          });
          void store.hydrate().then(session => {
            if (active) callback('INITIAL_SESSION', session);
          });
          return { data: { subscription: { unsubscribe: () => { active = false; unsubscribe(); } } } };
        },

        async getSessionFromUrl(href) {
          const url = href ?? (isBrowser() ? window.location.href : undefined);
          const found = url ? readAccessTokenFromUrl(url) : null;
          if (!found) return { data: null, error: null };
          // Strip the token before the network call: a failed lookup must not
          // leave a usable token in the address bar or the history.
          if (!href && isBrowser()) {
            window.history?.replaceState?.(window.history.state, '', found.cleanedHref);
          }
          // Checked before it is stored, so a rejected token never emits
          // SIGNED_IN. On success, sessionSync adopts it from the response.
          const { data, error } = await $fetch('/get-session', { auth: { type: 'Bearer', token: found.accessToken } });
          if (error) return { data: null, error };
          const verified = sessionFromResponse(data);
          if (!verified || !sameSession(verified.token, found.accessToken)
            || !sameSession(store.get()?.accessToken, verified.token)) {
            return { data: null, error: { message: 'The session in the URL is no longer valid.' } };
          }
          return currentSession(store) ?? { data: null, error: { message: 'The session in the URL is no longer valid.' } };
        },

        async exchangeCodeForSession(authCode) {
          const verifier = await options.verifiers.get();
          if (!verifier) {
            return { data: null, error: { message: 'No PKCE code verifier found: start the sign-in with flowType: "pkce" in this browser.' } };
          }
          const { data, error } = await $fetch('/exchange-code', {
            method: 'POST',
            body: { auth_code: authCode, code_verifier: verifier },
          });
          if (error) return { data: null, error };
          const verified = sessionFromResponse(data);
          if (!verified || !sameSession(store.get()?.accessToken, verified.token)) {
            return { data: null, error: { message: 'The code did not produce a session.' } };
          }
          await options.verifiers.clear();
          return currentSession(store) ?? { data: null, error: { message: 'The code did not produce a session.' } };
        },

        // Better Auth 1.7 serves custom OAuth providers through signIn.social;
        // kept so apps calling the 1.6 genericOAuthClient spelling keep working.
        signIn: {
          oauth2: ({ providerId, ...params }) =>
            $fetch('/sign-in/social', { method: 'POST', body: { provider: providerId, ...params } }),
        },
        reauthenticate: () => $fetch('/reauthenticate', { method: 'POST' }),
        updateUserCredentials: params => $fetch('/update-user-credentials', { method: 'POST', body: params }),
        admin: adminActions(http),
      };
    },
  };
}
