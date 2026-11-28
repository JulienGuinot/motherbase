import { APIError } from 'better-auth/api';
import { emailDeliveryMissing, type SendHookLike, type SmtpLike } from '../config/settings/email-dependencies';

// Better Auth sends most of its email and SMS through `runInBackgroundOrAwait`,
// which logs a failed send and still answers 200. A project with no SMTP or no
// SMS provider therefore told the SDK "code sent" and sent nothing. The check
// below runs before those endpoints instead, where a throw reaches the caller.

export type DeliveryChannel = 'email' | 'sms';

/** Endpoints (relative to /api/auth) whose whole job is to send an email. */
const EMAIL_PATHS = new Set([
  '/sign-in/magic-link',
  '/email-otp/send-verification-otp',
  '/email-otp/request-password-reset',
  '/forget-password/email-otp',
  '/email-otp/request-email-change',
  '/send-verification-email',
  '/reauthenticate',
]);

/** Endpoints whose whole job is to send an SMS. */
const SMS_PATHS = new Set(['/phone-number/send-otp', '/phone-number/request-password-reset']);

export interface DeliveryRoutes {
  /** The channel two-factor codes go out on, when two-factor OTP is on. */
  twoFactorChannel?: DeliveryChannel;
  /** Sign-up mails a verification link (email/password with verification required). */
  signUpSendsEmail?: boolean;
}

/** The channel a request to `path` will send on, or null when it sends nothing. */
export function deliveryChannel(path: string, routes: DeliveryRoutes): DeliveryChannel | null {
  if (EMAIL_PATHS.has(path)) return 'email';
  if (SMS_PATHS.has(path)) return 'sms';
  if (path === '/two-factor/send-otp') return routes.twoFactorChannel ?? null;
  if (path === '/sign-up/email' && routes.signUpSendsEmail) return 'email';
  return null;
}

export interface SmsLike {
  accountSid?: unknown;
  authToken?: unknown;
  from?: unknown;
  messagingServiceSid?: unknown;
}

/** True when the project can actually deliver on `channel`, by its transport or its send hook. */
export function canDeliver(
  channel: DeliveryChannel,
  config: { smtp?: SmtpLike; sms?: SmsLike; sendHook?: SendHookLike & { sms?: unknown } },
): boolean {
  if (channel === 'email') return emailDeliveryMissing(config.smtp, config.sendHook).length === 0;
  const hook = config.sendHook;
  if (hook?.enabled && hook.sms && hook.webhookUrl) return true;
  const sms = config.sms;
  return !!sms?.accountSid && !!sms?.authToken && !!(sms?.from || sms?.messagingServiceSid);
}

/** The error a caller gets instead of a 200 that sent nothing. */
export function deliveryNotConfigured(channel: DeliveryChannel): APIError {
  return channel === 'email'
    ? new APIError('SERVICE_UNAVAILABLE', {
        code: 'email_provider_not_configured',
        message:
          'This project cannot send email: configure Email · SMTP or Auth · Delivery override in Studio.',
      })
    : new APIError('SERVICE_UNAVAILABLE', {
        code: 'sms_provider_not_configured',
        message:
          'This project cannot send SMS: configure Phone / SMS or Auth · Delivery override in Studio.',
      });
}
