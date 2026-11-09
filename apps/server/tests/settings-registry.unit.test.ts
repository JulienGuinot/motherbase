import { describe, it, expect } from 'vitest';
import { AUTH_TOKEN_EXPIRY_LIMITS, getGroup, SETTINGS_GROUPS } from '../config/settings';

describe('auth.social group', () => {
  it('exists with a json providers field carrying clientSecret as a secret', () => {
    const g = getGroup('auth.social')!;
    expect(g).toBeTruthy();
    const f = g.fields.find(x => x.key === 'providers')!;
    expect(f.type).toBe('json');
    expect(f.secretKeys).toContain('clientSecret');
  });

  it('validates a providers map and seeds google from env fallback', () => {
    process.env.GOOGLE_CLIENT_ID = 'genv';
    const g = getGroup('auth.social')!;
    const parsed = g.schema.parse({ providers: { github: { enabled: true, clientId: 'a', clientSecret: 'b' } } }) as any;
    expect(parsed.providers.github.enabled).toBe(true);
    expect((g.envFallback() as any).providers.google.clientId).toBe('genv');
  });

  it('no longer exposes standalone auth.google / auth.apple', () => {
    expect(SETTINGS_GROUPS['auth.google']).toBeUndefined();
    expect(SETTINGS_GROUPS['auth.apple']).toBeUndefined();
  });
});

describe('auth.oauth.custom group', () => {
  it('validates an array of generic providers with a secret clientSecret', () => {
    const g = getGroup('auth.oauth.custom')!;
    const f = g.fields.find(x => x.key === 'providers')!;
    expect(f.type).toBe('json');
    expect(f.secretKeys).toContain('clientSecret');
    const parsed = g.schema.parse({
      providers: [{ providerId: 'acme', clientId: 'c', clientSecret: 's', discoveryUrl: 'https://acme/.well-known/openid-configuration' }],
    }) as any;
    expect(parsed.providers[0].providerId).toBe('acme');
  });

  it('rejects an entry missing providerId', () => {
    const g = getGroup('auth.oauth.custom')!;
    expect(() => g.schema.parse({ providers: [{ clientId: 'c' }] })).toThrow();
  });
});

describe('auth method + plugin groups', () => {
  const keys = ['auth.methods', 'auth.twoFactor', 'auth.passkey', 'auth.apiKey', 'auth.sso', 'auth.organization'];

  it('all exist and validate their env-fallback defaults', () => {
    for (const k of keys) {
      const g = getGroup(k)!;
      expect(g, k).toBeTruthy();
      expect(() => g.schema.parse(g.envFallback())).not.toThrow();
    }
  });

  it('auth.methods defaults emailPassword+magicLink+emailOTP on', () => {
    const v = getGroup('auth.methods')!.schema.parse({}) as any;
    expect(v.emailPassword).toBe(true);
    expect(v.magicLink).toBe(true);
    expect(v.emailOTP).toBe(true);
  });

  // Anonymous sign-ins are opt-in, as in Supabase: a guest is a real row, so an
  // endpoint open by default is a way to fill the users table.
  it('auth.methods has an anonymous toggle that defaults off', () => {
    const group = getGroup('auth.methods')!;
    expect(group.fields.map(f => f.key)).toContain('anonymous');
    expect(group.schema.parse({})).toMatchObject({ anonymous: false });
    expect(group.envFallback?.()).toMatchObject({ anonymous: false });
  });
});

describe('auth.tokens group', () => {
  const schema = getGroup('auth.tokens')!.schema;

  it('accepts both configured expiry boundaries', () => {
    expect(() =>
      schema.parse({
        accessTokenExpMin: AUTH_TOKEN_EXPIRY_LIMITS.accessTokenExpMin.min,
        refreshTokenExpDays: AUTH_TOKEN_EXPIRY_LIMITS.sessionExpDays.min,
      }),
    ).not.toThrow();
    expect(() =>
      schema.parse({
        accessTokenExpMin: AUTH_TOKEN_EXPIRY_LIMITS.accessTokenExpMin.max,
        refreshTokenExpDays: AUTH_TOKEN_EXPIRY_LIMITS.sessionExpDays.max,
      }),
    ).not.toThrow();
  });

  it('rejects non-positive and excessive expiry values', () => {
    expect(() => schema.parse({ accessTokenExpMin: 0, refreshTokenExpDays: 30 })).toThrow();
    expect(() => schema.parse({ accessTokenExpMin: 15, refreshTokenExpDays: 0 })).toThrow();
    expect(() =>
      schema.parse({
        accessTokenExpMin: AUTH_TOKEN_EXPIRY_LIMITS.accessTokenExpMin.max + 1,
        refreshTokenExpDays: 30,
      }),
    ).toThrow();
    expect(() =>
      schema.parse({
        accessTokenExpMin: 15,
        refreshTokenExpDays: AUTH_TOKEN_EXPIRY_LIMITS.sessionExpDays.max + 1,
      }),
    ).toThrow();
  });
});

describe('field-system primitives', () => {
  it('renders otpChannel as a select with off/email/sms options', () => {
    const g = getGroup('auth.twoFactor')!;
    const f = g.fields.find(x => x.key === 'otpChannel')!;
    expect(f.type).toBe('select');
    expect(f.options?.map(o => o.value)).toEqual(['off', 'email', 'sms']);
    for (const v of ['off', 'email', 'sms']) {
      expect(() => g.schema.parse({ ...g.envFallback(), otpChannel: v })).not.toThrow();
    }
  });

  it('renders emailDomainMode and storage driver as selects', () => {
    const mode = getGroup('auth.hooks.signUp')!.fields.find(x => x.key === 'emailDomainMode')!;
    expect(mode.type).toBe('select');
    expect(mode.options?.map(o => o.value)).toEqual(['off', 'allow', 'block']);
    const driver = getGroup('storage.provider')!.fields.find(x => x.key === 'driver')!;
    expect(driver.type).toBe('select');
    expect(driver.options?.map(o => o.value)).toEqual(['local', 's3']);
  });
});

describe('auth.signup group', () => {
  const g = () => getGroup('auth.signup')!;

  it('exists with sensible defaults', () => {
    expect(g()).toBeTruthy();
    const v = g().schema.parse({}) as any;
    expect(v.allowNewUsers).toBe(true);
    expect(v.requireEmailVerification).toBe(false);
    expect(v.autoSignInAfterVerify).toBe(true);
    expect(v.minPasswordLength).toBe(8);
    expect(v.maxPasswordLength).toBe(128);
  });

  it('validates env-fallback defaults and rejects min>max', () => {
    expect(() => g().schema.parse(g().envFallback())).not.toThrow();
    expect(() => g().schema.parse({ minPasswordLength: 200, maxPasswordLength: 10 })).toThrow();
  });
});
