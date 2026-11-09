import { APP_NAME } from '../constants/app.constants';
import type { GenericOAuthConfig, ProjectAuthDeps } from './instance';
import { buildClaims, parseFieldList, type AccessTokenConfig } from './hooks/access-token';
import { parseEventList, type EventHookConfig } from './hooks/event-hook';
import { parsePhoneTestNumbers } from './hooks/phone-test-numbers';

// Pure translations from the auth.* settings groups to `createProjectAuth`
// options. Settings rows are operator-edited JSON, hence the loose input types.

export function enabledSocialProviders(providers: Record<string, any> = {}): Record<string, any> {
  const enabled: Record<string, any> = {};
  for (const [id, p] of Object.entries(providers)) {
    if (!p?.enabled || !p.clientId || !p.clientSecret) continue;
    enabled[id] = { clientId: p.clientId, clientSecret: p.clientSecret };
    if (id === 'apple' && p.audiences) enabled[id].appBundleIdentifier = p.audiences;
  }
  return enabled;
}

export function usableGenericOAuth(providers: GenericOAuthConfig[] = []): GenericOAuthConfig[] {
  return providers.filter(p => p.providerId && p.clientId);
}

export function signupOptions(signup: any): ProjectAuthDeps['signup'] {
  return {
    allowNewUsers: signup?.allowNewUsers ?? true,
    requireEmailVerification: !!signup?.requireEmailVerification,
    autoSignInAfterVerify: signup?.autoSignInAfterVerify ?? true,
    minPasswordLength: signup?.minPasswordLength ?? 8,
    maxPasswordLength: signup?.maxPasswordLength ?? 128,
  };
}

export function sessionOptions(sessions: any): ProjectAuthDeps['sessions'] {
  return {
    revokeOnPasswordReset: sessions?.revokeOnPasswordReset ?? true,
    disableRefresh: !!sessions?.disableRefresh,
    updateAgeHours: sessions?.updateAgeHours ?? 24,
    freshAgeMinutes: sessions?.freshAgeMinutes ?? 0,
  };
}

export function twoFactorOptions(twoFactor: any): ProjectAuthDeps['twoFactor'] {
  if (!twoFactor?.enabled) return undefined;
  return {
    issuer: twoFactor.issuer || APP_NAME,
    totpDigits: twoFactor.totpDigits,
    totpPeriod: twoFactor.totpPeriod,
    otpChannel: twoFactor.otpChannel,
    otpDigits: twoFactor.otpDigits,
    otpPeriodMinutes: twoFactor.otpPeriodMinutes,
    backupCodeCount: twoFactor.backupCodeCount,
    backupCodeLength: twoFactor.backupCodeLength,
    trustDeviceDays: twoFactor.trustDeviceDays,
  };
}

/**
 * An empty endpoint list means "no auth call is guarded", which is not what
 * the plugin reads it as (it falls back to its own defaults), so the plugin is
 * not mounted at all then.
 */
export function captchaOptions(attack: any): ProjectAuthDeps['captcha'] {
  if (!attack?.captchaEnabled || !attack.captchaSecret || !attack.captchaAuthEndpoints?.length) return undefined;
  return {
    provider: attack.captchaProvider,
    secretKey: attack.captchaSecret,
    siteKey: attack.captchaSiteKey,
    endpoints: attack.captchaAuthEndpoints,
  };
}

export function passkeyOptions(passkey: any): ProjectAuthDeps['passkey'] {
  return passkey?.enabled ? { rpId: passkey.rpId, rpName: passkey.rpName, origin: passkey.origin } : undefined;
}

export function organizationOptions(org: any): ProjectAuthDeps['organization'] {
  return {
    enabled: org?.enabled ?? true,
    allowUserToCreateOrganization: org?.allowUserToCreateOrganization ?? true,
    // `allowOrgSso` is the old name of this flag. It never gated SSO (it only
    // ever turned on Better Auth teams) so it is read here purely so an
    // install that had it on keeps its teams after the rename.
    teamsEnabled: !!(org?.teamsEnabled ?? org?.allowOrgSso),
    maxMembers: org?.maxMembers ?? 0,
  };
}

export interface PhoneSignIn {
  /** An SMS can actually be delivered, or every number signing in is a test number. */
  smsReady: boolean;
  /** Absent when phone sign-in is off or cannot deliver. */
  options: ProjectAuthDeps['phoneOtp'];
}

/**
 * Phone sign-in needs both the auth toggle AND a usable SMS transport. Unless
 * every number that will sign in is a test number, which never calls the real
 * provider.
 */
export function phoneSignIn(phoneOtp: any, sms: any): PhoneSignIn {
  const testNumbers = parsePhoneTestNumbers(sms?.testNumbers);
  const smsReady =
    Object.keys(testNumbers).length > 0 ||
    (!!sms?.accountSid && !!sms?.authToken && !!(sms?.from || sms?.messagingServiceSid));
  if (!phoneOtp?.enabled || !smsReady) return { smsReady, options: undefined };
  return {
    smsReady,
    options: {
      otpLength: phoneOtp.otpLength,
      expiresIn: phoneOtp.expiresIn,
      signUpOnVerification: phoneOtp.signUpOnVerification,
      testNumbers,
    },
  };
}

/** The 2FA OTP channel that can actually deliver, or undefined when none is needed or possible. */
export function twoFactorOtpChannel(twoFactor: any, smsReady: boolean): 'email' | 'sms' | undefined {
  if (!twoFactor?.enabled) return undefined;
  if (twoFactor.otpChannel === 'email') return 'email';
  if (twoFactor.otpChannel === 'sms' && smsReady) return 'sms';
  return undefined;
}

export function eventHookConfig(raw: any): EventHookConfig | undefined {
  if (!raw?.enabled) return undefined;
  return {
    enabled: true,
    webhookUrl: raw.webhookUrl ?? '',
    webhookSecret: raw.webhookSecret ?? '',
    events: parseEventList(raw.events ?? ''),
  };
}

export function accessTokenClaims(hook: any): ProjectAuthDeps['accessTokenClaims'] {
  if (!hook?.enabled) return undefined;
  const cfg: AccessTokenConfig = {
    enabled: true,
    includeUserFields: parseFieldList(hook.includeUserFields),
    staticClaims: hook.staticClaims ?? {},
  };
  return user => buildClaims(cfg, user);
}
