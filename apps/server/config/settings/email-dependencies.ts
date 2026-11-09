// Which auth toggles cannot work without a way to send an email, and whether
// this project has one. Shared by SettingsService.set (refuses to turn a feature
// on) and AuthManager.status (reports the ones already on as unconfigured), so
// both surfaces answer the same question the same way.

export interface SmtpLike {
  host?: unknown;
  username?: unknown;
}

/** The `auth.hooks.send` delivery override, which replaces SMTP when it claims email. */
export interface SendHookLike {
  enabled?: unknown;
  webhookUrl?: unknown;
  email?: unknown;
}

/** Empty when an email can actually be delivered; otherwise what is missing. */
export function emailDeliveryMissing(smtp: SmtpLike | undefined, sendHook?: SendHookLike): string[] {
  if (sendHook?.enabled && sendHook.email && sendHook.webhookUrl) return [];
  return ['host', 'username'].filter(k => !smtp?.[k as keyof SmtpLike]);
}

/** Auth flags that send email, by settings group. */
const EMAIL_DEPENDENT: Record<string, Array<{ label: string; on: (v: Record<string, unknown>) => boolean }>> = {
  'auth.methods': [
    { label: 'Magic link', on: v => !!v.magicLink },
    { label: 'Email OTP', on: v => !!v.emailOTP },
  ],
  'auth.signup': [{ label: 'Require email verification', on: v => !!v.requireEmailVerification }],
  'auth.twoFactor': [{ label: 'Two-factor OTP by email', on: v => !!v.enabled && v.otpChannel === 'email' }],
};

/** Labels of the email-sending features `next` turns on that `previous` had off. */
export function emailFeaturesEnabledBy(
  group: string,
  next: Record<string, unknown>,
  previous: Record<string, unknown>,
): string[] {
  return (EMAIL_DEPENDENT[group] ?? []).filter(f => f.on(next) && !f.on(previous)).map(f => f.label);
}
