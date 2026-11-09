// Which Better Auth endpoint is which Supabase audit event.
//
// GoTrue writes one `auth.audit_log_entries` row per event, with a fixed
// vocabulary of `action` and `log_type` values that Supabase dashboards and
// queries filter on. This maps Better Auth's paths onto that vocabulary so the
// rows read the same. Paths with no Supabase counterpart (reads, session
// polling) are deliberately absent: an audit log is a record of changes.

export type AuditLogType = 'account' | 'team' | 'token' | 'user' | 'factor' | 'recovery_codes';

export interface AuditEvent {
  action: string;
  logType: AuditLogType;
  /** Extra `traits` Supabase records for this event, e.g. the provider. */
  traits?: Record<string, unknown>;
}

// Ordered: the first matching prefix wins, so `/sign-in/anonymous` has to be
// tested before the generic `/sign-in/` login. A null event silences a path the
// generic rule would otherwise catch: starting an OAuth or SSO flow is not a
// login, its callback is.
const RULES: Array<[prefix: string, event: AuditEvent | null]> = [
  ['/sign-up/', { action: 'user_signedup', logType: 'team' }],
  ['/sign-in/anonymous', { action: 'user_signedup', logType: 'team', traits: { provider: 'anonymous' } }],
  ['/sign-in/social', null],
  ['/sign-in/sso', null],
  // GoTrue records a magic-link request as a recovery request.
  ['/sign-in/magic-link', { action: 'user_recovery_requested', logType: 'user', traits: { provider: 'magiclink' } }],
  ['/sign-in/', { action: 'login', logType: 'account' }],
  ['/callback/', { action: 'login', logType: 'account', traits: { provider: 'oauth' } }],
  ['/sso/callback/', { action: 'login', logType: 'account', traits: { provider: 'sso' } }],
  ['/magic-link/verify', { action: 'login', logType: 'account', traits: { provider: 'magiclink' } }],
  ['/phone-number/verify', { action: 'login', logType: 'account', traits: { provider: 'phone' } }],
  ['/passkey/verify-authentication', { action: 'login', logType: 'account', traits: { provider: 'passkey' } }],
  ['/two-factor/verify-', { action: 'mfa_code_login', logType: 'account' }],
  ['/exchange-code', { action: 'token_refreshed', logType: 'token', traits: { grant_type: 'pkce' } }],
  ['/token', { action: 'token_refreshed', logType: 'token' }],
  ['/sign-out', { action: 'logout', logType: 'account' }],
  ['/revoke-session', { action: 'token_revoked', logType: 'token' }],
  ['/revoke-other-sessions', { action: 'token_revoked', logType: 'token' }],
  ['/email-otp/request-password-reset', { action: 'user_recovery_requested', logType: 'user' }],
  ['/request-password-reset', { action: 'user_recovery_requested', logType: 'user' }],
  ['/forget-password', { action: 'user_recovery_requested', logType: 'user' }],
  ['/email-otp/reset-password', { action: 'user_updated_password', logType: 'user' }],
  ['/reset-password', { action: 'user_updated_password', logType: 'user' }],
  ['/change-password', { action: 'user_updated_password', logType: 'user' }],
  ['/email-otp/send-verification-otp', { action: 'user_confirmation_requested', logType: 'user' }],
  ['/send-verification-email', { action: 'user_confirmation_requested', logType: 'user' }],
  ['/verify-email', { action: 'user_signedup', logType: 'team', traits: { confirmed: true } }],
  ['/reauthenticate', { action: 'user_reauthenticate_requested', logType: 'user' }],
  ['/update-user-credentials', { action: 'user_modified', logType: 'user' }],
  ['/update-user', { action: 'user_modified', logType: 'user' }],
  ['/change-email', { action: 'user_modified', logType: 'user' }],
  ['/delete-user', { action: 'user_deleted', logType: 'team' }],
  ['/link-social', { action: 'identity_linked', logType: 'account' }],
  ['/unlink-account', { action: 'identity_unlinked', logType: 'account' }],
  ['/two-factor/enable', { action: 'factor_in_progress', logType: 'factor', traits: { factor_type: 'totp' } }],
  ['/two-factor/disable', { action: 'factor_unenrolled', logType: 'factor', traits: { factor_type: 'totp' } }],
  ['/two-factor/generate-backup-codes', { action: 'generate_recovery_codes', logType: 'recovery_codes' }],
  ['/passkey/verify-registration', { action: 'factor_in_progress', logType: 'factor', traits: { factor_type: 'webauthn' } }],
  ['/passkey/delete-passkey', { action: 'factor_deleted', logType: 'factor', traits: { factor_type: 'webauthn' } }],
];

/**
 * The Supabase audit event a Better Auth path records, or null for none. A
 * prefix ending in `/` or `-` matches anything under it; any other matches the
 * path itself and its sub-paths, so `/token` is not `/tokens`.
 */
export function auditEventFor(path: string): AuditEvent | null {
  for (const [prefix, event] of RULES) {
    const open = prefix.endsWith('/') || prefix.endsWith('-');
    if (open ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`)) return event;
  }
  return null;
}

/** `account` and `token` events describe a session, so they need to know whose. */
export function auditNeedsActorId(event: AuditEvent): boolean {
  return event.logType === 'account' || event.logType === 'token' || event.logType === 'factor';
}

/** Every action this server can write, for the Studio filter. */
export const AUDIT_ACTIONS: readonly string[] = [
  ...new Set([
    ...RULES.flatMap(([, event]) => (event ? [event.action] : [])),
    // Written by UserAdminService for operator and secret-key changes.
    'user_invited',
    'user_modified',
    'user_deleted',
    'user_updated_password',
    'token_revoked',
    'factor_deleted',
  ]),
].sort();
