import { emailDeliveryMissing } from '../config/settings/email-dependencies';

export interface AuthStatusItem {
  id: string;
  // 'method' = native sign-in method (email/password, magic link, …). Included so
  // any "what's enabled" surface reads one source of truth and never contradicts
  // the Providers toggles.
  kind: 'method' | 'social' | 'oauth' | 'plugin';
  enabled: boolean;
  configured: boolean;
  missing: string[];
  callbackUrl?: string;
}

interface SettingsReader {
  get<T = any>(key: string): Promise<T>;
}

// Native method id → human label, in display order.
const NATIVE_METHODS: Array<{ id: string; label: string }> = [
  { id: 'emailPassword', label: 'Email & password' },
  { id: 'magicLink', label: 'Magic link' },
  { id: 'emailOTP', label: 'Email OTP' },
  { id: 'anonymous', label: 'Anonymous' },
];

const METHODS_NEEDING_EMAIL = new Set(['magicLink', 'emailOTP']);

/** An optional feature: when on, it reports `missing`; when off, nothing is missing. */
function toggleItem(id: string, kind: AuthStatusItem['kind'], enabled: boolean, missing: string[]): AuthStatusItem {
  const reported = enabled ? missing : [];
  return { id, kind, enabled, configured: reported.length === 0, missing: reported };
}

/**
 * Only email/password needs no external config; magic link and email OTP
 * cannot deliver anything without an email transport, so they report the SMTP
 * fields they are missing.
 */
function nativeMethodItems(methods: Record<string, boolean> | undefined, emailMissing: string[]): AuthStatusItem[] {
  return NATIVE_METHODS.map(({ id, label }) =>
    toggleItem(label, 'method', !!methods?.[id], METHODS_NEEDING_EMAIL.has(id) ? emailMissing : []),
  );
}

function socialItems(providers: Record<string, any>, base: string): AuthStatusItem[] {
  return Object.entries(providers).map(([id, p]) => {
    const missing = ['clientId', 'clientSecret'].filter(k => !p?.[k]);
    return {
      id,
      kind: 'social',
      enabled: !!p?.enabled,
      configured: missing.length === 0,
      missing: p?.enabled ? missing : [],
      callbackUrl: `${base}/api/auth/callback/${id}`,
    };
  });
}

function customOAuthItems(providers: any[], base: string): AuthStatusItem[] {
  return providers.map(p => {
    const missing = ['providerId', 'clientId'].filter(k => !p?.[k]);
    if (!p.discoveryUrl && !(p.authorizationUrl && p.tokenUrl)) missing.push('discoveryUrl|authorizationUrl+tokenUrl');
    return {
      id: p.providerId || '(unnamed)',
      kind: 'oauth',
      enabled: true,
      configured: missing.length === 0,
      missing,
      callbackUrl: `${base}/api/auth/callback/${p.providerId}`,
    };
  });
}

function smsTransportMissing(sms: any): string[] {
  const missing = ['accountSid', 'authToken'].filter(k => !sms?.[k]);
  if (!sms?.from && !sms?.messagingServiceSid) missing.push('from|messagingServiceSid');
  return missing;
}

/** Phone sign-in reports the SMS credentials it lacks even when off, unlike the plugins. */
function phoneItem(phone: any, smsMissing: string[]): AuthStatusItem {
  return {
    id: 'phone',
    kind: 'method',
    enabled: !!phone?.enabled,
    configured: smsMissing.length === 0,
    missing: phone?.enabled ? smsMissing : [],
  };
}

/**
 * The OTP channel drags in whichever transport it uses (SMS creds, or an
 * email transport). Plain TOTP needs neither.
 */
function twoFactorItem(tf: any, smsMissing: string[], emailMissing: string[]): AuthStatusItem {
  const missing = tf?.otpChannel === 'sms' ? smsMissing : tf?.otpChannel === 'email' ? emailMissing : [];
  return toggleItem('twoFactor', 'plugin', !!tf?.enabled, missing);
}

/** Enabled but with no rule configured is a no-op that always allows: flag it so the console can warn. */
function signUpGateItem(gate: any): AuthStatusItem {
  const hasRule = (gate?.emailDomainMode && gate.emailDomainMode !== 'off') || !!gate?.webhookUrl;
  return toggleItem('signUpGate', 'plugin', !!gate?.enabled, hasRule ? [] : ['emailDomainMode|webhookUrl']);
}

/** Enabled with no fields and no static claims is a no-op; flag it so the console can warn. */
function accessTokenHookItem(hook: any): AuthStatusItem {
  const hasClaims = !!(hook?.includeUserFields?.trim?.() || Object.keys(hook?.staticClaims ?? {}).length);
  return toggleItem('accessTokenHook', 'plugin', !!hook?.enabled, hasClaims ? [] : ['includeUserFields|staticClaims']);
}

/** Delivery override: enabled needs a URL and at least one channel selected. */
function sendHookItem(send: any): AuthStatusItem {
  const missing: string[] = [];
  if (!send?.webhookUrl) missing.push('webhookUrl');
  if (!send?.email && !send?.sms) missing.push('email|sms');
  return toggleItem('sendHook', 'plugin', !!send?.enabled, missing);
}

function eventHookItem(events: any): AuthStatusItem {
  return toggleItem('eventHook', 'plugin', !!events?.enabled, events?.webhookUrl ? [] : ['webhookUrl']);
}

/** Per provider/plugin readiness: enabled? configured? what is missing? callback URL. */
export async function authStatus(s: SettingsReader, base: string): Promise<AuthStatusItem[]> {
  const sendHook = await s.get('auth.hooks.send');
  const emailMissing = emailDeliveryMissing(await s.get('email.smtp'), sendHook).map(f => `email.smtp.${f}`);
  const smsMissing = smsTransportMissing(await s.get('phone.sms'));
  const social = await s.get<{ providers?: Record<string, any> }>('auth.social');
  const custom = await s.get<{ providers?: any[] }>('auth.oauth.custom');
  const passkey = await s.get('auth.passkey');

  return [
    ...nativeMethodItems(await s.get('auth.methods'), emailMissing),
    ...socialItems(social.providers ?? {}, base),
    ...customOAuthItems(custom.providers ?? [], base),
    toggleItem('passkey', 'plugin', !!passkey?.enabled, passkey?.rpId ? [] : ['rpId']),
    phoneItem(await s.get('auth.phoneOtp'), smsMissing),
    twoFactorItem(await s.get('auth.twoFactor'), smsMissing, emailMissing),
    signUpGateItem(await s.get('auth.hooks.signUp')),
    accessTokenHookItem(await s.get('auth.hooks.accessToken')),
    sendHookItem(sendHook),
    eventHookItem(await s.get('auth.hooks.events')),
    toggleItem('apiKey', 'plugin', !!(await s.get('auth.apiKey'))?.enabled, []),
    toggleItem('sso', 'plugin', !!(await s.get('auth.sso'))?.enabled, []),
  ];
}
