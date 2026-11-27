import { describe, it, expect } from 'vitest';
import { canDeliver, deliveryChannel } from '../auth/delivery-preflight';

describe('deliveryChannel', () => {
  it('names the channel of every endpoint that only sends', () => {
    expect(deliveryChannel('/sign-in/magic-link', {})).toBe('email');
    expect(deliveryChannel('/email-otp/send-verification-otp', {})).toBe('email');
    expect(deliveryChannel('/phone-number/send-otp', {})).toBe('sms');
    expect(deliveryChannel('/sign-in/email', {})).toBeNull();
  });

  it('follows the configuration for two-factor and sign-up', () => {
    expect(deliveryChannel('/two-factor/send-otp', {})).toBeNull();
    expect(deliveryChannel('/two-factor/send-otp', { twoFactorChannel: 'sms' })).toBe('sms');
    expect(deliveryChannel('/sign-up/email', {})).toBeNull();
    expect(deliveryChannel('/sign-up/email', { signUpSendsEmail: true })).toBe('email');
  });
});

describe('canDeliver', () => {
  const hook = { enabled: true, webhookUrl: 'https://hooks.test/send' };

  it('needs SMTP, or a send hook that claims email', () => {
    expect(canDeliver('email', {})).toBe(false);
    expect(canDeliver('email', { smtp: { host: 'smtp.test', username: 'u' } })).toBe(true);
    expect(canDeliver('email', { sendHook: { ...hook, email: true } })).toBe(true);
    expect(canDeliver('email', { sendHook: { ...hook, sms: true } })).toBe(false);
  });

  it('needs complete SMS credentials, or a send hook that claims SMS', () => {
    expect(canDeliver('sms', { sms: { accountSid: 'a', authToken: 't' } })).toBe(false);
    expect(canDeliver('sms', { sms: { accountSid: 'a', authToken: 't', from: '+1' } })).toBe(true);
    expect(canDeliver('sms', { sendHook: { ...hook, sms: true } })).toBe(true);
  });
});
