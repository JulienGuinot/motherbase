import { describe, it, expect } from 'vitest';
import {
  captchaOptions,
  enabledSocialProviders,
  phoneSignIn,
  twoFactorOtpChannel,
} from '../auth/auth-options';

const smsCreds = { accountSid: 'AC1', authToken: 't', from: '+15550000000' };

describe('auth options', () => {
  it('keeps only enabled social providers that have both credentials', () => {
    const providers = enabledSocialProviders({
      github: { enabled: true, clientId: 'a', clientSecret: 'b' },
      google: { enabled: true, clientId: 'a' },
      gitlab: { enabled: false, clientId: 'a', clientSecret: 'b' },
      apple: { enabled: true, clientId: 'a', clientSecret: 'b', audiences: 'com.app' },
    });
    expect(Object.keys(providers)).toEqual(['github', 'apple']);
    expect(providers.apple.appBundleIdentifier).toBe('com.app');
  });

  it('turns phone sign-in on only with a usable SMS transport or test numbers', () => {
    expect(phoneSignIn({ enabled: true }, {}).options).toBeUndefined();
    expect(phoneSignIn({ enabled: false }, smsCreds).options).toBeUndefined();
    expect(phoneSignIn({ enabled: true }, smsCreds).options).toBeDefined();
    expect(phoneSignIn({ enabled: true }, { testNumbers: '+15551234567:123456' }).smsReady).toBe(true);
  });

  it('delivers 2FA codes by SMS only when SMS can actually be sent', () => {
    expect(twoFactorOtpChannel({ enabled: true, otpChannel: 'email' }, false)).toBe('email');
    expect(twoFactorOtpChannel({ enabled: true, otpChannel: 'sms' }, false)).toBeUndefined();
    expect(twoFactorOtpChannel({ enabled: true, otpChannel: 'sms' }, true)).toBe('sms');
    expect(twoFactorOtpChannel({ enabled: false, otpChannel: 'email' }, true)).toBeUndefined();
  });

  it('does not mount captcha with an empty endpoint list', () => {
    const attack = { captchaEnabled: true, captchaSecret: 's', captchaProvider: 'turnstile', captchaAuthEndpoints: [] };
    expect(captchaOptions(attack)).toBeUndefined();
    expect(captchaOptions({ ...attack, captchaAuthEndpoints: ['/sign-up/email'] })?.endpoints).toEqual(['/sign-up/email']);
  });
});
