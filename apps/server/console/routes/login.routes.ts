import type { Request, RequestHandler, Response } from 'express';
import { errorMessage } from '../../lib/errors';
import type { LogBuffer } from '../../lib/log-buffer';
import type { AuthInstance } from '../auth/instance';
import { burnPasswordCheck } from '../auth/password';
import type { AuditStore } from '../services/audit.service';
import type { PlatformUsersService, User } from '../services/users.service';

interface LoginDeps {
  auth: AuthInstance;
  users: PlatformUsersService;
  audit: AuditStore;
  logs: LogBuffer;
}

type LoginOutcome =
  | 'authenticated'
  | 'second_factor_required'
  | 'invalid_credentials'
  | 'disabled'
  | 'authentication_error';

function normalizedAuditEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : 'unknown';
}

function recordLoginAudit(
  { audit, logs }: LoginDeps,
  req: Request,
  user: User | undefined,
  outcome: LoginOutcome,
): void {
  const email = normalizedAuditEmail(user?.email ?? req.body?.email);
  try {
    audit.append({
      actorId: user?.id ?? 'unknown',
      actorEmail: email,
      actorRole: user?.role ?? 'unknown',
      ip: typeof req.ip === 'string' ? req.ip : 'unknown',
      action: 'auth.login',
      target: `account:${email}`,
      success: outcome === 'authenticated' || outcome === 'second_factor_required',
      detail: { outcome },
    });
  } catch (error: unknown) {
    logs.push({ level: 'error', source: 'audit', message: `login audit failed: ${errorMessage(error)}` });
  }
}

const invalidCredentials = (res: Response) => res.status(401).json({ success: false, message: 'Invalid credentials' });

/**
 * Thin adapter so the existing console UI keeps calling /api/platform/login:
 * pre-check the account (existence + not-disabled, `disabled` is a console
 * field Better Auth doesn't gate on), then delegate to Better Auth and relay
 * its Set-Cookie so the browser gets a real Better Auth session.
 */
export function platformLoginHandler(deps: LoginDeps): RequestHandler {
  return async (req, res) => {
    const email = String(req.body?.email ?? '');
    const password = String(req.body?.password ?? '');
    const user = await deps.users.findByEmail(email);
    if (!user || user.disabled) {
      await burnPasswordCheck(password);
      recordLoginAudit(deps, req, user, user?.disabled ? 'disabled' : 'invalid_credentials');
      return invalidCredentials(res);
    }
    try {
      const response = await deps.auth.api.signInEmail({ body: { email, password }, asResponse: true });
      if (response.status !== 200) {
        recordLoginAudit(deps, req, user, 'invalid_credentials');
        return invalidCredentials(res);
      }
      // Forward whatever cookies Better Auth set: either the full session cookie,
      // or (when the operator has 2FA enrolled) a short-lived cookie that scopes the
      // follow-up verify-2fa call.
      for (const cookie of response.headers.getSetCookie()) res.append('Set-Cookie', cookie);
      // The twoFactor plugin's after-hook deletes the pre-2FA session and answers
      // `{ twoFactorRedirect: true }`, but the bearer plugin's after-hook runs FIRST
      // (plugin registration order) and has already stamped `set-auth-token` from the
      // now-doomed session cookie. So `set-auth-token` can be present yet worthless.
      // Trust the authoritative body flag, not the header: if 2FA is pending, stop
      // here and let the UI collect a TOTP code (posted to /api/auth/two-factor/
      // verify-totp, scoped by the short-lived cookie forwarded above).
      // No token and no flag is treated the same way, rather than leak a tokenless
      // "success".
      const body = await response.clone().json().catch(() => null);
      const token = response.headers.get('set-auth-token');
      if (body?.twoFactorRedirect || !token) {
        recordLoginAudit(deps, req, user, 'second_factor_required');
        return res.status(200).json({ success: true, data: { twoFactor: true, mustChangePassword: user.mustChangePassword } });
      }
      recordLoginAudit(deps, req, user, 'authenticated');
      deps.logs.push({ level: 'info', source: 'console', message: `platform login ${user.email}` });
      return res.status(200).json({ success: true, data: { token, mustChangePassword: user.mustChangePassword } });
    } catch {
      recordLoginAudit(deps, req, user, 'authentication_error');
      deps.logs.push({ level: 'error', source: 'console', message: 'platform authentication failed' });
      return res.status(500).json({ success: false, message: 'Authentication unavailable' });
    }
  };
}
