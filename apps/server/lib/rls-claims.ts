export type RlsRole = 'anon' | 'authenticated' | 'service_role';

/**
 * Every role the data plane may run as. One list, because two lists drift: the
 * realtime outbox used to carry its own copy without `service_role`, so every
 * REST write made with a secret key threw inside the transaction that carried
 * the data and rolled the write back.
 */
export const RLS_ROLES: ReadonlySet<RlsRole> = new Set<RlsRole>(['anon', 'authenticated', 'service_role']);

export interface RlsContext {
  role: RlsRole;
  /** JSON string passed verbatim to set_config('request.jwt.claims', …, true). */
  claims: string;
}

/** The only parts of the request caller the data plane needs to build RLS claims. */
export interface RlsUser {
  id?: string;
  role?: string;
  /** Surfaced to policies as the `email` claim, which is what `auth.email()` reads. */
  email?: string | null;
  /** A guest from `signInAnonymously()`. Surfaced as the `is_anonymous` claim,
   *  so a policy can tell guests apart: `(auth.jwt()->>'is_anonymous')::boolean`. */
  isAnonymous?: boolean | null;
  /**
   * A third-party JWT caller (auth/third-party.ts): its verified claims become
   * `request.jwt.claims` as they are, and `externalRole` the Postgres role.
   * Never set for a Better Auth user.
   */
  external?: { role: 'anon' | 'authenticated'; claims: Record<string, unknown> };
  /**
   * Run as `service_role`, which holds BYPASSRLS.
   *
   * Carried on the caller rather than passed as a separate argument on purpose:
   * every data-plane entry point already threads `user` all the way down to
   * `rlsContextFor`, so this cannot be forgotten on one path and honoured on
   * another. It is set in exactly one place, `callerFor` in
   * middlewares/api-key.middleware.ts, and only for a verified secret key.
   * Nothing derived from a request body or from a user's own token reaches it.
   */
  serviceRole?: boolean;
}

export function rlsContextFor(user?: RlsUser | null): RlsContext {
  if (user?.serviceRole) {
    // `sub` is kept when a user token rode along with the secret key, so a
    // SECURITY INVOKER view or a trigger reading auth.uid() still sees who the
    // call was made on behalf of. It changes no access decision: RLS is bypassed
    // for this role either way.
    return {
      role: 'service_role',
      claims: JSON.stringify({
        sub: user.id ?? null,
        role: 'service_role',
        email: user.email ?? null,
        user_role: user.role ?? null,
      }),
    };
  }
  if (user?.external) {
    // The issuer's own claims, as Supabase passes them, with `role` pinned to
    // the one the claim resolved to (never anything the token could widen).
    return { role: user.external.role, claims: JSON.stringify({ ...user.external.claims, role: user.external.role }) };
  }
  if (user?.id) {
    return {
      role: 'authenticated',
      claims: JSON.stringify({
        sub: user.id,
        role: 'authenticated',
        email: user.email ?? null,
        user_role: user.role ?? null,
        is_anonymous: !!user.isAnonymous,
      }),
    };
  }
  return { role: 'anon', claims: JSON.stringify({ role: 'anon' }) };
}
