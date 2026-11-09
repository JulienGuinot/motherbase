import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AuthManager } from '../auth/auth-manager';

// Offline: builds instances from a fake SettingsService. No DB connection happens
// until a query, so a real PrismaClient is safe to pass without connecting.
function fakeDi(settings: Record<string, any>) {
  const defaults: Record<string, unknown> = {
    'auth.tokens': { accessTokenExpMin: 15, refreshTokenExpDays: 30 },
  };
  return {
    prisma: new PrismaClient(),
    SettingsService: { get: async (k: string) => settings[k] ?? defaults[k] ?? {} },
    TransporterService: { sendMail: async () => {} },
  } as any;
}

describe('AuthManager', () => {
  it('builds an instance exposing configured social + plugin endpoints', async () => {
    const mgr = new AuthManager(
      fakeDi({
        'auth.social': { providers: { github: { enabled: true, clientId: 'a', clientSecret: 'b' } } },
        'auth.methods': { emailPassword: true, magicLink: true, emailOTP: true },
        'auth.apiKey': { enabled: true },
        'auth.organization': { enabled: true, allowUserToCreateOrganization: true },
      }),
    );
    const auth = await mgr.current();
    expect(typeof auth.handler).toBe('function');
    expect(typeof (auth.api as any).createApiKey).toBe('function');
  });

  it('reload() rebuilds so a settings change is reflected', async () => {
    let apiKeyOn = false;
    const di = {
      prisma: new PrismaClient(),
      TransporterService: { sendMail: async () => {} },
      SettingsService: {
        get: async (k: string) =>
          k === 'auth.apiKey'
            ? { enabled: apiKeyOn }
            : k === 'auth.methods'
              ? { emailPassword: true }
              : k === 'auth.tokens'
                ? { accessTokenExpMin: 15, refreshTokenExpDays: 30 }
                : {},
      },
    } as any;
    const mgr = new AuthManager(di);
    const before = await mgr.current();
    expect((before.api as any).createApiKey).toBeUndefined();
    apiKeyOn = true;
    mgr.reload();
    const after = await mgr.current();
    expect(typeof (after.api as any).createApiKey).toBe('function');
    expect(after).not.toBe(before);
  });

  it('applies token settings to JWT, persistent session, and session cookie lifetimes', async () => {
    let tokens = { accessTokenExpMin: 30, refreshTokenExpDays: 14 };
    const di = fakeDi({ 'auth.methods': { emailPassword: true } });
    di.SettingsService.get = async (key: string) => (key === 'auth.tokens' ? tokens : {});
    const mgr = new AuthManager(di);

    const before = await mgr.current();
    const beforeJwt = (before.options.plugins as any[]).find(plugin => plugin.id === 'jwt');
    const beforeContext = await before.$context;
    expect(beforeJwt.options.jwt.expirationTime).toBe('30m');
    expect(before.options.session?.expiresIn).toBe(14 * 86_400);
    expect(beforeContext.authCookies.sessionToken.attributes.maxAge).toBe(14 * 86_400);

    tokens = { accessTokenExpMin: 5, refreshTokenExpDays: 2 };
    mgr.reload();
    const after = await mgr.current();
    const afterJwt = (after.options.plugins as any[]).find(plugin => plugin.id === 'jwt');
    expect(afterJwt.options.jwt.expirationTime).toBe('5m');
    expect(after.options.session?.expiresIn).toBe(2 * 86_400);
    expect(after).not.toBe(before);
  });

  it('reports missing fields and callback URL for a half-filled social provider', async () => {
    const mgr = new AuthManager(
      fakeDi({
        'auth.social': { providers: { github: { enabled: true, clientId: 'a', clientSecret: '' } } },
        'auth.methods': { emailPassword: true },
      }),
    );
    const items = await mgr.status();
    const gh = items.find(i => i.id === 'github')!;
    expect(gh.enabled).toBe(true);
    expect(gh.configured).toBe(false);
    expect(gh.missing).toContain('clientSecret');
    expect(gh.callbackUrl).toContain('/api/auth/callback/github');
  });

  it('reports phone sign-in as configured only when SMS creds are complete', async () => {
    const ready = new AuthManager(
      fakeDi({
        'auth.methods': { emailPassword: true },
        'auth.phoneOtp': { enabled: true, otpLength: 6, expiresIn: 300, signUpOnVerification: true },
        'phone.sms': { accountSid: 'AC', authToken: 'tok', from: '+1' },
      }),
    );
    const phoneReady = (await ready.status()).find(i => i.id === 'phone')!;
    expect(phoneReady.enabled).toBe(true);
    expect(phoneReady.configured).toBe(true);
    expect(phoneReady.missing).toHaveLength(0);

    const missing = new AuthManager(
      fakeDi({
        'auth.methods': { emailPassword: true },
        'auth.phoneOtp': { enabled: true },
        'phone.sms': { accountSid: 'AC' }, // no token, no from/messagingServiceSid
      }),
    );
    const phoneMissing = (await missing.status()).find(i => i.id === 'phone')!;
    expect(phoneMissing.enabled).toBe(true);
    expect(phoneMissing.configured).toBe(false);
    expect(phoneMissing.missing).toEqual(expect.arrayContaining(['authToken', 'from|messagingServiceSid']));
  });

  it('reports 2FA as unconfigured when the SMS channel lacks transport creds', async () => {
    const smsChannelNoCreds = new AuthManager(
      fakeDi({
        'auth.methods': { emailPassword: true },
        'auth.twoFactor': { enabled: true, otpChannel: 'sms' },
        'phone.sms': {}, // no creds
      }),
    );
    const tf = (await smsChannelNoCreds.status()).find(i => i.id === 'twoFactor')!;
    expect(tf.enabled).toBe(true);
    expect(tf.configured).toBe(false);
    expect(tf.missing.length).toBeGreaterThan(0);

    // TOTP-only (channel off) is always ready: no external delivery needed.
    const totpOnly = new AuthManager(
      fakeDi({ 'auth.methods': { emailPassword: true }, 'auth.twoFactor': { enabled: true, otpChannel: 'off' } }),
    );
    const tf2 = (await totpOnly.status()).find(i => i.id === 'twoFactor')!;
    expect(tf2.configured).toBe(true);
    expect(tf2.missing).toHaveLength(0);
  });

  it('flags the sign-up gate as unconfigured when enabled with no rule', async () => {
    const noRule = new AuthManager(
      fakeDi({ 'auth.methods': { emailPassword: true }, 'auth.hooks.signUp': { enabled: true, emailDomainMode: 'off', webhookUrl: '' } }),
    );
    const g1 = (await noRule.status()).find(i => i.id === 'signUpGate')!;
    expect(g1.enabled).toBe(true);
    expect(g1.configured).toBe(false);

    const withRule = new AuthManager(
      fakeDi({ 'auth.methods': { emailPassword: true }, 'auth.hooks.signUp': { enabled: true, emailDomainMode: 'allow', emailDomains: 'acme.com' } }),
    );
    const g2 = (await withRule.status()).find(i => i.id === 'signUpGate')!;
    expect(g2.configured).toBe(true);
  });

  it('wires the twoFactor plugin (TOTP + backup codes) when enabled', async () => {
    const mgr = new AuthManager(
      fakeDi({
        'auth.methods': { emailPassword: true },
        'auth.twoFactor': { enabled: true, issuer: 'Acme', totpDigits: 6, otpChannel: 'off' },
      }),
    );
    const auth = await mgr.current();
    expect(typeof (auth.api as any).enableTwoFactor).toBe('function');
    expect(typeof (auth.api as any).getTOTPURI).toBe('function');
  });

  it('wires the phoneNumber plugin when phone sign-in is enabled and SMS is ready', async () => {
    const mgr = new AuthManager(
      fakeDi({
        'auth.methods': { emailPassword: true },
        'auth.phoneOtp': { enabled: true, otpLength: 6, expiresIn: 300, signUpOnVerification: true },
        'phone.sms': { accountSid: 'AC', authToken: 'tok', from: '+1' },
      }),
    );
    const auth = await mgr.current();
    expect(typeof (auth.api as any).sendPhoneNumberOTP).toBe('function');
  });

  it('does not register organization endpoints when organizations are disabled', async () => {
    const disabled = new AuthManager(
      fakeDi({
        'auth.methods': { emailPassword: true },
        'auth.organization': { enabled: false, allowUserToCreateOrganization: true },
      }),
    );
    const enabled = new AuthManager(
      fakeDi({
        'auth.methods': { emailPassword: true },
        'auth.organization': { enabled: true, allowUserToCreateOrganization: true },
      }),
    );

    expect(((await disabled.current()).api as any).createOrganization).toBeUndefined();
    expect(typeof ((await enabled.current()).api as any).createOrganization).toBe('function');
  });

  it('maps auth.signup to emailAndPassword options', async () => {
    const mgr = new AuthManager(
      fakeDi({
        'auth.methods': { emailPassword: true },
        'auth.signup': {
          allowNewUsers: false,
          requireEmailVerification: true,
          autoSignInAfterVerify: false,
          minPasswordLength: 12,
          maxPasswordLength: 64,
        },
      }),
    );
    const auth = await mgr.current();
    const ep = (auth.options as any).emailAndPassword;
    expect(ep.disableSignUp).toBe(true);
    expect(ep.requireEmailVerification).toBe(true);
    expect(ep.minPasswordLength).toBe(12);
    expect(ep.maxPasswordLength).toBe(64);
  });

  it('defaults to open signup when auth.signup is unset', async () => {
    const mgr = new AuthManager(fakeDi({ 'auth.methods': { emailPassword: true } }));
    const auth = await mgr.current();
    const ep = (auth.options as any).emailAndPassword;
    expect(ep.disableSignUp).toBeFalsy();
    expect(ep.minPasswordLength).toBe(8);
  });

  it('maps auth.sessions to session + emailAndPassword revocation options', async () => {
    const mgr = new AuthManager(
      fakeDi({
        'auth.methods': { emailPassword: true },
        'auth.tokens': { accessTokenExpMin: 15, refreshTokenExpDays: 30 },
        'auth.sessions': { revokeOnPasswordReset: false, disableRefresh: false, updateAgeHours: 12, freshAgeMinutes: 5 },
      }),
    );
    const auth = await mgr.current();
    const opts = auth.options as any;
    expect(opts.session.updateAge).toBe(12 * 3600);
    expect(opts.session.freshAge).toBe(5 * 60);
    expect(opts.session.expiresIn).toBe(30 * 86_400);
    expect(opts.emailAndPassword.revokeSessionsOnPasswordReset).toBe(false);
  });

  it('disables sliding refresh when requested', async () => {
    const mgr = new AuthManager(
      fakeDi({ 'auth.methods': { emailPassword: true }, 'auth.sessions': { disableRefresh: true } }),
    );
    const opts = (await mgr.current()).options as any;
    expect(opts.session.disableSessionRefresh).toBe(true);
    expect(opts.session.updateAge).toBeUndefined();
  });

  it('sends an email-verification LINK (url, not the raw token) when verification is required', async () => {
    const sent: Array<{ to: string; subject: string; html: string }> = [];
    const di = {
      prisma: new PrismaClient(),
      TransporterService: { sendMail: async (m: any) => { sent.push(m); } },
      SettingsService: {
        get: async (k: string) =>
          k === 'auth.methods' ? { emailPassword: true }
          : k === 'auth.signup' ? { allowNewUsers: true, requireEmailVerification: true, autoSignInAfterVerify: true, minPasswordLength: 8, maxPasswordLength: 128 }
          : k === 'auth.tokens' ? { accessTokenExpMin: 15, refreshTokenExpDays: 30 }
          : {},
      },
    } as any;
    const mgr = new AuthManager(di);
    const auth = await mgr.current();
    const ev = (auth.options as any).emailVerification;
    expect(typeof ev?.sendVerificationEmail).toBe('function');

    const url = 'https://app.example.com/api/auth/verify-email?token=JWT.TOKEN.VALUE&callbackURL=/';
    await ev.sendVerificationEmail({ user: { email: 'u@example.com' }, url, token: 'JWT.TOKEN.VALUE' });

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('u@example.com');
    // Rendered as a clickable anchor; the url's `&` is HTML-escaped in the href.
    expect(sent[0].html).toContain('href="https://app.example.com/api/auth/verify-email?token=JWT.TOKEN.VALUE');
    expect(sent[0].html).toContain('&amp;callbackURL=/');
    expect(sent[0].html).not.toContain('Your code is'); // not the OTP code template
  });
});
