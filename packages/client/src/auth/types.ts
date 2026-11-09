import type { BetterFetch, BetterFetchPlugin, BetterFetchResponse } from '@better-fetch/fetch';
import type { AuthClient as BetterAuthClient } from 'better-auth/client';
import type { passkeyClient } from '@better-auth/passkey/client';
import type { ssoClient } from '@better-auth/sso/client';
import type { apiKeyClient } from '@better-auth/api-key/client';
import type {
  anonymousClient,
  emailOTPClient,
  jwtClient,
  magicLinkClient,
  organizationClient,
  phoneNumberClient,
  twoFactorClient,
} from 'better-auth/client/plugins';
import type { AuthAdminClient } from '../admin/auth-admin-client.js';
import type { AuthAdminMfaClient } from '../admin/auth-admin-mfa-client.js';
import type { VerifierStore } from './pkce.js';

/**
 * A timestamp as it can reach the client: ISO string over HTTP, `Date` when a
 * server-side caller passes a Better Auth row straight in.
 */
export type Timestamp = string | Date;

/**
 * The open bag of profile fields.
 *
 * `User` itself is closed: every field the platform sets is declared, and a
 * typo like `user.emailVerifed` is a compile error. Project-specific columns
 * (anything added to `user.additionalFields` on the server) cannot be known
 * here, so they live in this bag, which is the one place with an index
 * signature. `compat.ts` copies every non-platform field into it, so a custom
 * `plan` column is readable as `user.user_metadata.plan`.
 *
 * Declare your own shape for it when you know the columns:
 * `const meta = user.user_metadata as { plan?: string }`.
 */
export interface UserMetadata {
  name?: string | null;
  image?: string | null;
  [key: string]: unknown;
}

/** Fields Better Auth itself owns on a user row. */
export interface BetterAuthUserFields {
  /** Display name. Better Auth's own column, mirrored into `user_metadata`. */
  name?: string | null;
  /** Avatar URL. Better Auth's own column, mirrored into `user_metadata`. */
  image?: string | null;
  /** Better Auth stores verification as a boolean, not a timestamp. */
  emailVerified?: boolean;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
  /** Set by the `phoneNumber` plugin; aliased to `phone`. */
  phoneNumber?: string | null;
  phoneNumberVerified?: boolean | null;
  /** Set by the `admin` plugin. */
  banned?: boolean | null;
  banReason?: string | null;
  banExpires?: Timestamp | null;
  /** Set by the `twoFactor` plugin. */
  twoFactorEnabled?: boolean | null;
  /** Set by the `anonymous` plugin; aliased to `is_anonymous`. */
  isAnonymous?: boolean | null;
}

/**
 * The `additionalFields` Motherbase configures on every project's auth
 * instance (see `apps/server/auth/instance.ts`). The first four are
 * client-writable through `updateUser`; the rest are server-set.
 */
export interface MotherbaseUserFields {
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  imageUrl?: string | null;
  /** `'USER'` by default on the server, `'authenticated'` after `compat.ts`. */
  role?: string;
  status?: string | null;
  classicEmail?: string | null;
  appleId?: string | null;
  appleEmail?: string | null;
  googleId?: string | null;
  googleEmail?: string | null;
}

/**
 * The snake_case aliases `compat.ts` adds on the way out, so code ported from
 * supabase-js reads `user.created_at` and `user.user_metadata.full_name` on a
 * user that came out of Better Auth.
 *
 * They are optional because a `User` you construct yourself (a test fixture, a
 * value on its way *in*) has not been through `compat.ts` yet. Everything the
 * SDK hands back has them.
 */
export interface SupabaseUserAliases {
  /** Always `'authenticated'`. Present for supabase-js parity. */
  aud?: string;
  created_at?: string | null;
  updated_at?: string | null;
  /** Non-null once the email is verified. Better Auth stores a boolean, so the
   *  value is the last-update timestamp rather than the true verification time. */
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
  /** Alias of `phoneNumber`, `''` when the user has no phone. */
  phone?: string;
  /**
   * Always `{}`: the client is not told which provider issued the session, and
   * a guessed `{ provider: 'email' }` is worse than a missing one.
   */
  app_metadata?: Record<string, unknown>;
  /** Profile fields (`name`, `image`, any configured additional field). */
  user_metadata?: UserMetadata;
  identities?: UserIdentity[];
  is_anonymous?: boolean;
}

/** A linked provider, in the supabase-js `UserIdentity` shape. */
export interface UserIdentity {
  id: string;
  identity_id: string;
  user_id: string;
  provider: string;
  identity_data: Record<string, unknown>;
  created_at: string | null;
  updated_at: string | null;
  last_sign_in_at: string | null;
}

/**
 * Authenticated user as returned by the API.
 *
 * Closed on purpose: every field the platform can set is declared above, so
 * reading one that does not exist is a compile error instead of a silent
 * `undefined` at runtime. Project-specific columns go through
 * [`UserMetadata`](#UserMetadata) (`user.user_metadata.<field>`).
 */
export interface User extends BetterAuthUserFields, MotherbaseUserFields, SupabaseUserAliases {
  id: string;
  email: string;
}

/**
 * The bearer token issued by sign-up / sign-in. With Better Auth this is the
 * session token; there is no separate refresh token (a session is valid until
 * it expires, after which the user re-authenticates). `refreshToken` is kept
 * optional for backwards source-compat and is unused.
 */
export interface Tokens {
  accessToken: string;
  refreshToken?: string;
}

/**
 * The locally-held session: the bearer token plus the user it belongs to.
 *
 * The snake_case fields are supabase-js aliases, added by the session store on
 * the way out (see `compat.ts`). `access_token` always mirrors `accessToken`;
 * `expires_at` / `expires_in` are present only when the server dated the
 * session, because supabase-js callers schedule refreshes off them and a
 * fabricated expiry schedules them wrong.
 */
export interface Session extends Tokens {
  user: User;
  /** supabase-js alias of `accessToken`. */
  access_token?: string;
  /** supabase-js alias of `refreshToken`. Always null on Better Auth sessions. */
  refresh_token?: string | null;
  token_type?: 'bearer';
  /** Unix seconds. Absent when the backend did not date the session. */
  expires_at?: number;
  /** Seconds until `expires_at`. Absent for the same reason. */
  expires_in?: number;
}

/** Session payload returned by Better Auth after sign-in or second-factor verification. */
export interface AuthPayload {
  token: string;
  user: User;
}

/**
 * Persists the session between runs. Implementations must be synchronous-or-async
 * tolerant: every method may return a value or a promise of it.
 */
export interface SessionStorageAdapter {
  get(): Session | null | Promise<Session | null>;
  set(session: Session | null): void | Promise<void>;
}

/**
 * A key/value store shaped like `window.localStorage` or React Native's
 * `AsyncStorage`. supabase-js takes its session storage in this form, so an app
 * being ported passes one of these; the client wraps it (see
 * `keyValueStorage`) rather than failing at runtime on a missing `.get`.
 */
export interface KeyValueStorageAdapter {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/**
 * Supabase-compatible auth change events emitted by `onAuthStateChange`.
 *
 * `INITIAL_SESSION` is fired once per subscription, right after subscribing,
 * with whatever session was already stored. supabase-js does the same, and an
 * app that clears its loading flag on it hangs forever without it.
 */
export type AuthChangeEvent =
  | 'INITIAL_SESSION'
  | 'SIGNED_IN'
  | 'SIGNED_OUT'
  | 'TOKEN_REFRESHED'
  | 'USER_UPDATED'
  | 'PASSWORD_RECOVERY'
  | 'MFA_CHALLENGE_VERIFIED';
export type AuthChangeListener = (event: AuthChangeEvent, session: Session | null) => void;

/** Internal event names used by the session store. */
export type AuthEvent = 'signIn' | 'signOut' | 'tokenRefreshed' | 'userUpdated' | 'mfaVerified';
export type AuthListener = (event: AuthEvent, session: Session | null) => void;

/**
 * `implicit` returns the session in the redirect's URL fragment. `pkce`
 * returns `?code=` instead, for `exchangeCodeForSession`.
 */
export type AuthFlowType = 'implicit' | 'pkce';

export interface SocialSignInBody {
  provider?: string;
  callbackURL?: string;
  errorCallbackURL?: string;
  newUserCallbackURL?: string;
  scopes?: string[];
  disableRedirect?: boolean;
  idToken?: unknown;
}

/** `auth.admin`: the public methods of `AuthAdminClient`, `mfa` included. */
export type AuthAdminActions = Omit<AuthAdminClient, 'mfa'> & { mfa: Omit<AuthAdminMfaClient, never> };

export interface AuthClientOptions {
  /** The project URL. Better Auth is mounted under `/api/auth`. */
  url: string;
  fetch: typeof fetch;
  /** Client-level headers (`apikey`, impersonation), sent on every auth call too. */
  headers: Record<string, string>;
  flowType: AuthFlowType;
  /** Where the PKCE verifier waits out the redirect. */
  verifiers: VerifierStore;
}

export interface Subscription {
  unsubscribe(): void;
}

export interface SessionResult {
  data: { user: User; session: Session } | null;
  /** Better Auth's error shape. */
  error: { message?: string; status?: number; statusText?: string } | null;
}

/** What Motherbase adds to Better Auth's client. */
export interface MotherbaseAuthActions {
  /**
   * Subscribe to session changes. The callback fires once with
   * `INITIAL_SESSION` as soon as the stored session has been read, so an app
   * can leave its loading state for a signed-out visitor too, then on every
   * sign-in, sign-out and user update made through `client.auth`. Delivered
   * asynchronously: unsubscribing synchronously suppresses it.
   */
  onAuthStateChange(callback: AuthChangeListener): { data: { subscription: Subscription } };
  /**
   * Finish a social, SSO or magic-link sign-in on the page the server sent the
   * browser back to: read the `#access_token=` it appended and adopt that
   * session. `createClient` already does this on load unless
   * `auth.detectSessionInUrl` is false. Resolves with `data: null` and no error
   * when the URL carries no token, so it is safe on every page.
   */
  getSessionFromUrl(href?: string): Promise<SessionResult>;
  /**
   * Finish a PKCE sign-in: trade the `?code=` the redirect came back with for
   * the session. Needs the verifier the sign-in stored, so it works once, in
   * the browser that started the flow. `createClient` already does this on load.
   */
  exchangeCodeForSession(authCode: string): Promise<SessionResult>;
  signIn: {
    /**
     * Sign in with a custom OIDC/OAuth2 provider configured on the server.
     * Same as `signIn.social({ provider: providerId, ... })`, which is how
     * Better Auth 1.7 serves these providers.
     */
    oauth2(params: {
      providerId: string;
      callbackURL?: string;
      errorCallbackURL?: string;
      newUserCallbackURL?: string;
      disableRedirect?: boolean;
      scopes?: string[];
      requestSignUp?: boolean;
    }): Promise<BetterFetchResponse<{ url: string; redirect: boolean }>>;
  };
  /** Email the signed-in user a one-time code to pass as `nonce` to `updateUserCredentials`. */
  reauthenticate(): Promise<BetterFetchResponse<{ success: boolean }>>;
  /**
   * Set the signed-in user's email or password where Better Auth's own
   * `changeEmail` / `changePassword` cannot: an anonymous user's first address
   * (which makes it permanent, keeping its id), a first password, or a password
   * replaced with the `nonce` from `reauthenticate()`.
   */
  updateUserCredentials(params: { email?: string; password?: string; nonce?: string }): Promise<BetterFetchResponse<{ user: User }>>;
  /**
   * User administration for server code holding a secret key. Present on every
   * client because whether the key is secret is a server-side fact: with a
   * publishable key, these answer 401.
   */
  admin: AuthAdminActions;
}

export interface MotherbaseClientPlugin {
  id: 'motherbase';
  fetchPlugins: BetterFetchPlugin[];
  getActions: ($fetch: BetterFetch) => MotherbaseAuthActions;
}

/**
 * The client plugins matching what auth/instance.ts mounts on the server, plus
 * Motherbase's. Spelled out as a type so `client.auth` has a name in the
 * declarations: inferred, it is too large for TypeScript to write down.
 * `createAuthClient` builds the same list as values, and the compiler checks
 * the two agree, element by element.
 */
export type AuthPlugins = [
  ReturnType<typeof anonymousClient>,
  ReturnType<typeof emailOTPClient>,
  ReturnType<typeof magicLinkClient>,
  ReturnType<typeof phoneNumberClient>,
  ReturnType<typeof twoFactorClient>,
  ReturnType<typeof organizationClient<{ teams: { enabled: true } }>>,
  ReturnType<typeof jwtClient>,
  ReturnType<typeof passkeyClient>,
  // Instantiated on purpose: a bare `ReturnType` of the generic ssoClient is
  // `any`, which erases every plugin from the inferred client.
  ReturnType<typeof ssoClient<Record<never, never>>>,
  ReturnType<typeof apiKeyClient>,
  MotherbaseClientPlugin,
];

/** `client.auth`: Better Auth's client, with Motherbase's session handling. */
export type AuthClient = BetterAuthClient<{ plugins: AuthPlugins }>;
