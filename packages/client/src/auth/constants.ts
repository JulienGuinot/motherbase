import { AuthChangeEvent, AuthEvent } from "./types.js";

export const EVENT_MAP: Record<AuthEvent, AuthChangeEvent> = {
  signIn: 'SIGNED_IN',
  signOut: 'SIGNED_OUT',
  tokenRefreshed: 'TOKEN_REFRESHED',
  userUpdated: 'USER_UPDATED',
  mfaVerified: 'MFA_CHALLENGE_VERIFIED',
};

/**
 * Endpoints whose next step needs a cookie set on the response: the OAuth
 * state, the WebAuthn challenge, or the pending second factor a password
 * sign-in leaves for `twoFactor.verify*`. Cross-origin, fetch only keeps and
 * resends a cookie with `credentials: 'include'`. Everything else stays
 * `same-origin`, so a backend that does not allow credentialed CORS still
 * serves it.
 */
export const COOKIE_PATHS = [
  '/sign-in/email',
  '/sign-in/phone-number',
  '/two-factor/',
  '/sign-in/social',
  '/sign-in/sso',
  '/link-social',
  '/passkey/',
];

/** Sign-ins that come back through the server's OAuth callback, where the PKCE challenge rides. */
export const REDIRECT_SIGN_IN_PATHS = ['/sign-in/social', '/sign-in/sso'];

/** Calls after which the session this client holds no longer exists. */
export const SIGN_OUT_PATHS = new Set(['/sign-out', '/revoke-sessions']);

/**
 * Calls that change the user but answer without it (`{ status: true }`): the
 * session is read again after them, so the stored user and USER_UPDATED follow.
 */
export const USER_CHANGE_PATHS = new Set(['/update-user', '/change-email', '/update-user-credentials', '/two-factor/disable']);
