import { describe, it, expect } from 'vitest';
import { AUDIT_ACTIONS, auditEventFor, auditNeedsActorId } from '../auth/audit-actions';

describe('auditEventFor', () => {
  it.each([
    ['/sign-up/email', 'user_signedup'],
    ['/sign-in/email', 'login'],
    ['/sign-in/anonymous', 'user_signedup'],
    ['/callback/google', 'login'],
    ['/two-factor/verify-totp', 'mfa_code_login'],
    ['/token', 'token_refreshed'],
    ['/sign-out', 'logout'],
    ['/email-otp/request-password-reset', 'user_recovery_requested'],
    ['/email-otp/reset-password', 'user_updated_password'],
    ['/update-user', 'user_modified'],
    ['/delete-user', 'user_deleted'],
    ['/unlink-account', 'identity_unlinked'],
    ['/two-factor/disable', 'factor_unenrolled'],
  ])('%s records %s', (path, action) => {
    expect(auditEventFor(path)?.action).toBe(action);
  });

  it('marks an anonymous sign-up with its provider', () => {
    expect(auditEventFor('/sign-in/anonymous')?.traits).toEqual({ provider: 'anonymous' });
  });

  // Starting a flow is not a login: the generic /sign-in/ rule must not claim it.
  it('records nothing for the start of an OAuth or SSO flow, or for reads', () => {
    for (const path of ['/sign-in/social', '/sign-in/sso', '/get-session', '/list-sessions', '/jwks', '/tokens']) {
      expect(auditEventFor(path)).toBeNull();
    }
  });

  it('requires an actor id for session events but not for a recovery request', () => {
    expect(auditNeedsActorId(auditEventFor('/sign-in/email')!)).toBe(true);
    expect(auditNeedsActorId(auditEventFor('/email-otp/request-password-reset')!)).toBe(false);
  });

  it('lists every action once, sorted, for the Studio filter', () => {
    expect(AUDIT_ACTIONS).toEqual([...new Set(AUDIT_ACTIONS)].sort());
    expect(AUDIT_ACTIONS).toContain('user_invited');
  });
});
