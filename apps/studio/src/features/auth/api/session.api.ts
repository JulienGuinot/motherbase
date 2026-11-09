import { api } from '@/shared/lib/api';

interface ConsoleLoginResult {
  data?: {
    token?: string;
    twoFactor?: boolean;
    mustChangePassword?: boolean;
  };
  token?: string;
  twoFactor?: boolean;
  mustChangePassword?: boolean;
}

export const sessionApi = {
  consoleLogin: (email: string, password: string) =>
    api.post('/platform/login', { email, password }).then(r => r.data as ConsoleLoginResult),
  // Second step of a console 2FA sign-in. The short-lived cookie from /login
  // scopes this call; Better Auth returns the real session bearer token in the
  // `set-auth-token` header (body.token is a fallback).
  verifyConsole2fa: (code: string, trustDevice = false) =>
    api.post('/auth/two-factor/verify-totp', { code, trustDevice }).then(r => ({
      token: (r.headers['set-auth-token'] as string | undefined) ?? r.data?.token,
    })),
};
