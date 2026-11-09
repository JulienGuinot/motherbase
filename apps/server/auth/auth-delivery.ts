import { APP_NAME } from '../constants/app.constants';
import type IContextContainer from '../context/icontext-container';
import { sendTemplatedAuthOtp, renderAuthLinkEmail, type AuthEmailTemplates, type AuthLinkTemplates } from './email-templates';
import { deliverViaHook, type AuthMessage, type SendHookConfig } from './hooks/send-hook';
import type { OtpArgs, ProjectAuthDeps } from './instance';

type Channel = AuthMessage['channel'];

interface AuthDeliveryOptions {
  /** auth.hooks.send: a project webhook that may claim a message instead of us sending it. */
  sendHook: SendHookConfig | undefined;
  /** Spends one message of the hourly quota for the channel, or throws a 429. */
  spendQuota: (channel: Channel) => void;
  /** True when `captureMessages()` took the message, which must then not be sent. */
  captured: (message: AuthMessage) => boolean;
}

/**
 * Delivers every email and SMS Better Auth asks for. Each path tries the
 * project's delivery hook first, and only sends through the built-in transport
 * when the hook did not claim the message.
 */
export class AuthDelivery {
  constructor(
    private readonly di: IContextContainer,
    private readonly options: AuthDeliveryOptions,
  ) {}

  /**
   * Every delivery path starts here, which is why the hourly send quota
   * (Auth · Rate limits) is spent here too: one check covers them all.
   */
  private tryHook(message: AuthMessage): Promise<boolean> {
    this.options.spendQuota(message.channel);
    return deliverViaHook(this.options.sendHook, message, { outboundHttpClient: this.di.OutboundHttpClient });
  }

  private linkTemplates(): Promise<Partial<AuthLinkTemplates> | undefined> {
    return this.di.SettingsService.get<Partial<AuthLinkTemplates>>('email.templates').catch(() => undefined);
  }

  readonly emailOtp = async ({ email, otp, type }: OtpArgs): Promise<void> => {
    if (this.options.captured({ channel: 'email', kind: 'email-otp', to: email, otp })) return;
    if (await this.tryHook({ channel: 'email', kind: 'email-otp', to: email, otp })) return;
    await sendTemplatedAuthOtp(
      {
        loadTemplates: () => this.di.SettingsService.get<AuthEmailTemplates>('email.templates'),
        sendMail: options => this.di.TransporterService.sendMail(options),
        appName: APP_NAME,
      },
      { email, otp, type },
    );
  };

  /** GoTrue's reauthentication email: a bare code, like the two-factor one. */
  readonly reauthenticationNonce = async ({ email, nonce }: { email: string; nonce: string }): Promise<void> => {
    if (await this.tryHook({ channel: 'email', kind: 'reauthentication', to: email, otp: nonce })) return;
    await this.di.TransporterService.sendMail({
      to: email,
      subject: `${APP_NAME} confirmation code`,
      html: `<p>Enter this code to confirm it is you: <strong>${nonce}</strong></p>`,
    });
  };

  readonly magicLink = async ({ email, url }: { email: string; url: string }): Promise<void> => {
    if (this.options.captured({ channel: 'email', kind: 'magic-link', to: email, url })) return;
    if (await this.tryHook({ channel: 'email', kind: 'magic-link', to: email, url })) return;
    await this.di.TransporterService.sendMail({
      to: email,
      ...renderAuthLinkEmail(await this.linkTemplates(), 'magic-link', { url, email }, APP_NAME),
    });
  };

  /** Not offered to the delivery hook: a verification link always goes out by email. */
  readonly verificationLink = async ({ email, url }: { email: string; url: string }): Promise<void> => {
    if (this.options.captured({ channel: 'email', kind: 'verify', to: email, url })) return;
    this.options.spendQuota('email');
    await this.di.TransporterService.sendMail({
      to: email,
      ...renderAuthLinkEmail(await this.linkTemplates(), 'verify', { url, email }, APP_NAME),
    });
  };

  readonly smsOtp = async ({ phoneNumber, code }: { phoneNumber: string; code: string }): Promise<void> => {
    if (await this.tryHook({ channel: 'sms', kind: 'sms-otp', to: phoneNumber, otp: code })) return;
    await this.di.SmsService.sendOtp(phoneNumber, code);
  };

  /** 2FA OTP delivery over `channel`: SMS needs a verified phone, email an address. */
  twoFactorOtp(channel: Channel): NonNullable<ProjectAuthDeps['sendTwoFactorOtp']> {
    return async ({ user, otp }) => {
      if (channel === 'sms') {
        if (!user.phoneNumber) throw new Error('No phone number on file for SMS two-factor.');
        if (await this.tryHook({ channel: 'sms', kind: 'two-factor', to: user.phoneNumber, otp })) return;
        await this.di.SmsService.sendOtp(user.phoneNumber, otp);
        return;
      }
      if (!user.email) throw new Error('No email on file for email two-factor.');
      if (await this.tryHook({ channel: 'email', kind: 'two-factor', to: user.email, otp })) return;
      await this.di.TransporterService.sendMail({
        to: user.email,
        subject: `${APP_NAME} two-factor code`,
        html: `<h1>Your two-factor code is: ${otp}</h1>`,
      });
    };
  }
}
