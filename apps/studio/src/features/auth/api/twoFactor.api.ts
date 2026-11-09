import { api } from '@/shared/lib/api';
import { auth } from '@/shared/lib/auth';

// Console-operator 2FA (TOTP), backed by the Better Auth twoFactor plugin mounted
// at /api/auth/two-factor/*. Enrollment is a two-step flow: `enable` stores the
// secret and returns the provisioning URI + one-time backup codes; `verifyTotp`
// confirms a code from the authenticator and *activates* 2FA. Until verify
// succeeds `twoFactorEnabled` stays false, so an abandoned enrollment never locks
// the operator out.

export interface EnableResult {
  totpURI: string;
  backupCodes: string[];
}

/** Pull the base32 secret out of an otpauth:// URI for manual key entry. */
export function secretFromTotpURI(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get('secret');
  } catch {
    return null;
  }
}

export const twoFactorApi = {
  /** Current operator's enrollment state, read live from the session. */
  status: () =>
    api.get('/auth/get-session').then(r => ({
      enabled: Boolean(r.data?.user?.twoFactorEnabled),
      email: r.data?.user?.email as string | undefined,
    })),
  /** Step 1: re-check password, receive the TOTP secret + backup codes (once). */
  enable: (password: string) =>
    api.post('/auth/two-factor/enable', { password }).then(r => r.data as EnableResult),
  /**
   * Step 2: confirm an authenticator code: this is what turns 2FA on.
   * Activating 2FA rotates the session server-side: Better Auth creates a fresh
   * session and DELETES the current one. The old bearer token in localStorage is
   * now dead, so we MUST swap in the rotated token from `set-auth-token`. Else the
   * very next request 401s and the operator is silently logged out.
   */
  verifyTotp: (code: string) =>
    api.post('/auth/two-factor/verify-totp', { code }).then(r => {
      const rotated = (r.headers['set-auth-token'] as string | undefined) ?? r.data?.token;
      if (rotated) auth.set(rotated);
      return r.data;
    }),
  /** Turn 2FA off (requires the password). */
  disable: (password: string) =>
    api.post('/auth/two-factor/disable', { password }).then(r => r.data),
};
