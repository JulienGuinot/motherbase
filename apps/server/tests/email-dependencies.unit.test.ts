import { describe, it, expect } from 'vitest';
import { emailDeliveryMissing, emailFeaturesEnabledBy } from '../config/settings/email-dependencies';

describe('emailDeliveryMissing', () => {
  it('names the missing SMTP fields', () => {
    expect(emailDeliveryMissing({})).toEqual(['host', 'username']);
    expect(emailDeliveryMissing({ host: 'smtp.example.com' })).toEqual(['username']);
    expect(emailDeliveryMissing({ host: 'smtp.example.com', username: 'a@b.c' })).toEqual([]);
  });

  it('accepts the send hook as the transport when it claims email', () => {
    const hook = { enabled: true, email: true, webhookUrl: 'https://hook.test' };
    expect(emailDeliveryMissing({}, hook)).toEqual([]);
    expect(emailDeliveryMissing({}, { ...hook, email: false })).toEqual(['host', 'username']);
    expect(emailDeliveryMissing({}, { ...hook, webhookUrl: '' })).toEqual(['host', 'username']);
  });
});

describe('emailFeaturesEnabledBy', () => {
  it('reports only the features this save turns on', () => {
    expect(emailFeaturesEnabledBy('auth.methods', { magicLink: true, emailOTP: true }, { emailOTP: true }))
      .toEqual(['Magic link']);
    expect(emailFeaturesEnabledBy('auth.methods', { magicLink: true }, { magicLink: true })).toEqual([]);
    expect(emailFeaturesEnabledBy('auth.signup', { requireEmailVerification: true }, {}))
      .toEqual(['Require email verification']);
    expect(emailFeaturesEnabledBy('auth.twoFactor', { enabled: true, otpChannel: 'sms' }, {})).toEqual([]);
    expect(emailFeaturesEnabledBy('auth.twoFactor', { enabled: true, otpChannel: 'email' }, {}))
      .toEqual(['Two-factor OTP by email']);
  });

  it('ignores groups that send no email', () => {
    expect(emailFeaturesEnabledBy('auth.tokens', { accessTokenExpMin: 15 }, {})).toEqual([]);
  });
});
