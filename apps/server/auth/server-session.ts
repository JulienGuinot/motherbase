import { AsyncLocalStorage } from 'node:async_hooks';

// Better Auth's jwt plugin answers every `/get-session` with a freshly signed
// access token in the `set-auth-jwt` header. That is for a client calling the
// endpoint over HTTP. When this server resolves a session for its own use
// (auth middleware, socket handshake, rate-limit identity) nobody reads the
// header, and producing it cost a read of the signing keys plus a signature on
// every authenticated request.
//
// The plugin reads `disableSettingJwtHeader` from its options at call time, so
// the project instance (auth/instance.ts) answers it from this store: true
// inside `readSession`, false for everything else, HTTP callers included.

const serverSideRead = new AsyncLocalStorage<true>();

/** Whether the current async context is a `readSession` call. */
export const isServerSideSessionRead = (): boolean => serverSideRead.getStore() === true;

type SessionReader = { api: { getSession: (input: { headers: Headers }) => unknown } };

/**
 * `auth.api.getSession` for this server's own use. Every in-process session
 * lookup goes through here rather than calling `getSession` directly.
 */
export function readSession<A extends SessionReader>(auth: A, headers: Headers): ReturnType<A['api']['getSession']> {
  return serverSideRead.run(true, () => auth.api.getSession({ headers })) as ReturnType<A['api']['getSession']>;
}
