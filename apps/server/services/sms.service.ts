import BaseContext from '../context/base-context';
import { APP_NAME } from '../constants/app.constants';

// SMS analog of TransporterService (email). Provider-agnostic: an internal
// SmsProvider interface with a Twilio implementation for now. Credentials are
// read from the console-editable `auth.phoneOtp` settings group, not env. The
// same config-driven pattern the rest of the auth stack uses.

// SMS transport credentials (settings group `phone.sms`). Shared by auth phone
// OTP, MFA and notifications.
export interface SmsConfig {
  provider: string;
  accountSid: string;
  authToken: string;
  from: string;
  messagingServiceSid: string;
}

export interface SendSmsArgs {
  to: string;
  body: string;
}

interface SmsProvider {
  send(args: SendSmsArgs): Promise<void>;
}

/** Twilio REST provider: mirrors the /Messages.json call shape used by the
 *  twilio edge-function integration snippet. */
class TwilioProvider implements SmsProvider {
  constructor(private cfg: SmsConfig) {}

  async send({ to, body }: SendSmsArgs): Promise<void> {
    const { accountSid, authToken, from, messagingServiceSid } = this.cfg;
    if (!accountSid || !authToken || !(from || messagingServiceSid)) {
      throw new Error(
        'Twilio SMS is not fully configured (accountSid, authToken and from/messagingServiceSid required).'
      );
    }
    const params = new URLSearchParams({ To: to, Body: body });
    if (messagingServiceSid) params.set('MessagingServiceSid', messagingServiceSid);
    else params.set('From', from);

    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    // This is not an operator-controlled URL: scheme and hostname are constant,
    // and the only configured path segment is percent-encoded. Unlike webhook
    // URLs, it cannot redirect the initial request to an internal host.
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      }
    );
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.message ?? `Twilio error ${res.status}`);
    }
  }
}

export class SmsService extends BaseContext {
  private async config(): Promise<SmsConfig> {
    return this.di.SettingsService.get<SmsConfig>('phone.sms');
  }

  private provider(cfg: SmsConfig): SmsProvider {
    switch (cfg.provider) {
      case 'twilio':
      default:
        return new TwilioProvider(cfg);
    }
  }

  async sendSms(args: SendSmsArgs): Promise<void> {
    const cfg = await this.config();
    await this.provider(cfg).send(args);
  }

  /** Deliver an auth one-time code. Body kept short to stay in one SMS segment. */
  async sendOtp(phoneNumber: string, code: string): Promise<void> {
    await this.sendSms({ to: phoneNumber, body: `${code} is your ${APP_NAME} verification code.` });
  }

  /** Validate credentials by sending a test SMS, before anything relies on them. */
  async sendTestSms(to: string): Promise<{ ok: true; ms: number }> {
    const started = Date.now();
    const cfg = await this.config();
    await this.provider(cfg).send({ to, body: `${APP_NAME} SMS configuration works.` });
    return { ok: true, ms: Date.now() - started };
  }
}
