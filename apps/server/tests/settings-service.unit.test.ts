import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { SettingsService } from '../services/settings.service';
import { SECRET_SENTINEL, getGroup, listGroups } from '../config/settings';

process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

// Known user ids the tests reference; resolveUserId must map anything else to null
// to avoid the app_settings_updatedById_fkey FK violation (e.g. the synthetic
// 'platform' console-proxy admin, which has no User row).
const KNOWN_USER_IDS = new Set(['user-1', 'u1']);

function fakeDi(initialRow: any = null) {
  const store: Record<string, any> = {};
  if (initialRow) store['email.smtp'] = initialRow;
  const prisma = {
    user: {
      findUnique: async ({ where }: any) => (KNOWN_USER_IDS.has(where.id) ? { id: where.id } : null),
    },
    appSetting: {
      findUnique: async ({ where }: any) => store[where.key] ?? null,
      upsert: async ({ where, create, update }: any) => {
        store[where.key] = { key: where.key, ...(store[where.key] || create), ...update };
        return store[where.key];
      },
      deleteMany: async ({ where }: any) => {
        const count = store[where.key] ? 1 : 0;
        delete store[where.key];
        return { count };
      },
    },
  };
  return { di: { prisma } as any, store };
}

describe('SettingsService', () => {
  beforeEach(() => {
    process.env.EMAIL_SMTP_HOST = 'env-host';
    process.env.EMAIL_SMTP_USERNAME = 'env-user';
    process.env.EMAIL_SMTP_PASSWORD = 'env-pass';
  });

  it('falls back to env when no DB row exists', async () => {
    const { di } = fakeDi();
    const svc = new SettingsService(di);
    const cfg = await svc.get<any>('email.smtp');
    expect(cfg.host).toBe('env-host');
    expect(cfg.password).toBe('env-pass');
    expect(await svc.source('email.smtp')).toBe('env');
  });

  it('writes, encrypts secrets, and reads them back decrypted', async () => {
    const { di, store } = fakeDi();
    const svc = new SettingsService(di);
    await svc.set('email.smtp', { host: 'db-host', port: 587, username: 'u', password: 'p', from: 'f@x', secure: false }, 'user-1');
    expect(JSON.stringify(store['email.smtp'].value)).not.toContain('"p"');
    const cfg = await svc.get<any>('email.smtp');
    expect(cfg.host).toBe('db-host');
    expect(cfg.password).toBe('p');
    expect(await svc.source('email.smtp')).toBe('db');
  });

  it('masks secrets on read and preserves them when re-saved with the sentinel', async () => {
    const { di } = fakeDi();
    const svc = new SettingsService(di);
    await svc.set('email.smtp', { host: 'h', port: 25, username: 'u', password: 'secret', from: '', secure: true }, 'u1');
    const masked = await svc.getMasked('email.smtp');
    expect(masked.values.password).toBe(SECRET_SENTINEL);
    expect(masked.values.host).toBe('h');
    await svc.set('email.smtp', { host: 'h2', port: 25, username: 'u', password: SECRET_SENTINEL, from: '', secure: true }, 'u1');
    expect((await svc.get<any>('email.smtp')).password).toBe('secret');
    expect((await svc.get<any>('email.smtp')).host).toBe('h2');
  });

  it('resets a persisted group to its masked environment fallback and invalidates the cache', async () => {
    const { di, store } = fakeDi();
    const svc = new SettingsService(di);
    await svc.set(
      'email.smtp',
      { host: 'db-host', port: 25, username: 'db-user', password: 'db-secret', from: '', secure: false },
      'u1'
    );
    await expect(svc.get<any>('email.smtp')).resolves.toMatchObject({ host: 'db-host', password: 'db-secret' });

    const reset = await svc.reset('email.smtp', 'u1');

    expect(store['email.smtp']).toBeUndefined();
    expect(reset).toMatchObject({ group: 'email.smtp', source: 'env' });
    expect(reset.values).toMatchObject({ host: 'env-host', username: 'env-user', password: SECRET_SENTINEL });
    await expect(svc.get<any>('email.smtp')).resolves.toMatchObject({ host: 'env-host', password: 'env-pass' });
  });

  it('validates the group before reset', async () => {
    const { di } = fakeDi();
    const svc = new SettingsService(di);

    await expect(svc.reset('nope.group', 'u1')).rejects.toMatchObject({ statusCode: 404 });
  });



  it('encrypts and masks nested secret keys in a json field (auth.social)', async () => {
    const { di, store } = fakeDi();
    const svc = new SettingsService(di);

    await svc.set('auth.social', { providers: { github: { enabled: true, clientId: 'id', clientSecret: 'shh' } } }, 'u1');
    // Encrypted at rest (ciphertext, not plaintext).
    const storedSecret = store['auth.social'].value.providers.github.clientSecret as string;
    expect(storedSecret.startsWith('v1:')).toBe(true);
    // Masked on read.
    const masked = await svc.getMasked('auth.social');
    expect((masked.values as any).providers.github.clientSecret).toBe(SECRET_SENTINEL);
    // Decrypted server-side.
    const decrypted = await svc.get<any>('auth.social');
    expect(decrypted.providers.github.clientSecret).toBe('shh');
    expect(decrypted.providers.github.clientId).toBe('id');
  });

  it('keeps a stored nested secret when the sentinel is sent back (auth.social)', async () => {
    const { di } = fakeDi();
    const svc = new SettingsService(di);
    await svc.set('auth.social', { providers: { github: { enabled: true, clientId: 'id', clientSecret: 'shh' } } }, 'u1');
    await svc.set('auth.social', { providers: { github: { enabled: true, clientId: 'id2', clientSecret: SECRET_SENTINEL } } }, 'u1');
    const decrypted = await svc.get<any>('auth.social');
    expect(decrypted.providers.github.clientSecret).toBe('shh');
    expect(decrypted.providers.github.clientId).toBe('id2');
  });

  it('encrypts secrets per entry in a json array field (auth.oauth.custom)', async () => {
    const { di } = fakeDi();
    const svc = new SettingsService(di);
    await svc.set('auth.oauth.custom', { providers: [{ providerId: 'acme', clientId: 'c', clientSecret: 's', discoveryUrl: 'https://acme/.well-known/openid-configuration' }] }, 'u1');
    const decrypted = await svc.get<any>('auth.oauth.custom');
    expect(decrypted.providers[0].providerId).toBe('acme');
    expect(decrypted.providers[0].clientSecret).toBe('s');
    // Re-save with sentinel keeps it.
    await svc.set('auth.oauth.custom', { providers: [{ providerId: 'acme', clientId: 'c2', clientSecret: SECRET_SENTINEL, discoveryUrl: 'https://acme/.well-known/openid-configuration' }] }, 'u1');
    const again = await svc.get<any>('auth.oauth.custom');
    expect(again.providers[0].clientSecret).toBe('s');
    expect(again.providers[0].clientId).toBe('c2');
  });

  it('declares the Studio settings tabs as API-backed groups', async () => {
    const groupKeys = listGroups().map(g => g.key);
    expect(groupKeys).toEqual([
      'server.cors',
      'security.rateLimit',
      'security.rateLimitRules',
      'auth.tokens',
      'auth.methods',
      'auth.signup',
      'auth.sessions',
      'auth.social',
      'auth.oauth.custom',
      'auth.twoFactor',
      'auth.passkey',
      'auth.phoneOtp',
      'auth.hooks.signUp',
      'auth.hooks.accessToken',
      'auth.hooks.send',
      'auth.hooks.events',
      'auth.urls',
      'auth.rateLimits',
      'auth.thirdParty',
      'auth.attackProtection',
      'auth.apiKey',
      'auth.sso',
      'auth.organization',
      'email.smtp',
      'phone.sms',
      'email.templates',
      'storage.provider',
      'storage.limits',
      'storage.imageTransform',
      'storage.s3',
      'storage.policies',
      'push.fcm',
      'push.apns',
      'backup.schedule',
      'data.retention',
      'logs.retention',
      'realtime.retention',
      'realtime.limits',
      'database.sqlEditor',
      'api.rest',
      'api.keys',
      'ai.assistant',
      'git.github',
    ]);
    expect(getGroup('phone.sms')?.fields.map(f => f.key)).toEqual([
      'provider',
      'accountSid',
      'authToken',
      'from',
      'messagingServiceSid',
      'testNumbers',
    ]);
    expect(getGroup('auth.phoneOtp')?.fields.map(f => f.key)).toEqual([
      'enabled',
      'otpLength',
      'expiresIn',
      'signUpOnVerification',
    ]);
    expect(getGroup('storage.provider')?.fields.find(f => f.key === 's3SecretAccessKey')?.secret).toBe(true);
    expect(getGroup('push.fcm')?.fields.find(f => f.key === 'privateKey')?.secret).toBe(true);
    expect(getGroup('push.apns')?.fields.find(f => f.key === 'key')?.secret).toBe(true);
    // Newly added groups
    expect(getGroup('server.cors')?.fields.map(f => f.key)).toEqual(['origins', 'credentials']);
    expect(getGroup('auth.tokens')?.fields.map(f => f.key)).toEqual(['accessTokenExpMin', 'refreshTokenExpDays']);
  });

  it('round-trips the formerly placeholder settings groups', async () => {
    const { di } = fakeDi();
    const svc = new SettingsService(di);

    await svc.set('phone.sms', { provider: 'twilio', accountSid: 'AC1', authToken: 'tok', from: '+15551234567' }, 'u1');
    await svc.set('email.templates', { verificationSubject: 'Verify', verificationBody: '{{code}}', recoverySubject: 'Reset', recoveryBody: '{{code}}' }, 'u1');
    await svc.set('storage.provider', { driver: 's3', staticPath: 'uploads', userPath: 'users', s3Region: 'eu-west-1', s3AccessKeyId: 'ak', s3SecretAccessKey: 'sk', s3Bucket: 'bucket' }, 'u1');
    await svc.set('push.fcm', { enabled: true, projectId: 'p', clientEmail: 'svc@example.com', privateKey: 'pk' }, 'u1');
    await svc.set('push.apns', { enabled: true, key: 'apns-key', keyId: 'kid', teamId: 'team', bundleId: 'app', production: true }, 'u1');

    await expect(svc.get<any>('phone.sms')).resolves.toMatchObject({ accountSid: 'AC1', authToken: 'tok' });
    await expect(svc.get<any>('email.templates')).resolves.toMatchObject({ verificationSubject: 'Verify' });
    await expect(svc.get<any>('storage.provider')).resolves.toMatchObject({ driver: 's3', s3SecretAccessKey: 'sk' });
    await expect(svc.get<any>('push.fcm')).resolves.toMatchObject({ enabled: true, privateKey: 'pk' });
    await expect(svc.get<any>('push.apns')).resolves.toMatchObject({ production: true, key: 'apns-key' });
  });

  it('round-trips the new server/console/auth-token settings groups', async () => {
    const { di } = fakeDi();
    const svc = new SettingsService(di);

    await svc.set('server.cors', { origins: 'https://app.example.com', credentials: true }, 'u1');
    await svc.set('auth.tokens', { accessTokenExpMin: 30, refreshTokenExpDays: 60 }, 'u1');
    await svc.set('auth.phoneOtp', { enabled: true, otpLength: 4, expiresIn: 120, signUpOnVerification: false }, 'u1');
    await svc.set('auth.twoFactor', { enabled: true, issuer: 'Acme', totpDigits: 8, totpPeriod: 30, otpChannel: 'sms', otpDigits: 6, otpPeriodMinutes: 5, backupCodeCount: 12, backupCodeLength: 10, trustDeviceDays: 14 }, 'u1');

    await expect(svc.get<any>('server.cors')).resolves.toMatchObject({ origins: 'https://app.example.com', credentials: true });
    await expect(svc.get<any>('auth.phoneOtp')).resolves.toMatchObject({ enabled: true, otpLength: 4, expiresIn: 120, signUpOnVerification: false });
    await expect(svc.get<any>('auth.twoFactor')).resolves.toMatchObject({ enabled: true, issuer: 'Acme', totpDigits: 8, otpChannel: 'sms', backupCodeCount: 12 });
    await expect(svc.get<any>('auth.tokens')).resolves.toMatchObject({ accessTokenExpMin: 30, refreshTokenExpDays: 60 });
  });

  it('stores null updatedById when the user is not a real DB user (platform proxy / stale id)', async () => {
    const { di, store } = fakeDi();
    const svc = new SettingsService(di);
    // The console proxy authenticates as the synthetic 'platform' admin which has
    // no User row: attributing it would trip the FK constraint, so it must be null.
    await svc.set('email.templates', { verificationSubject: 'Verify' }, 'platform');
    expect(store['email.templates'].updatedById).toBeNull();

    // A real user id is still attributed.
    await svc.set('auth.apiKey', { enabled: true }, 'user-1');
    expect(store['auth.apiKey'].updatedById).toBe('user-1');

    // No user id at all also stores null.
    await svc.set('server.cors', { origins: '', credentials: true });
    expect(store['server.cors'].updatedById).toBeNull();
  });

  it('rejects unknown groups', async () => {
    const { di } = fakeDi();
    const svc = new SettingsService(di);
    await expect(svc.get('nope.group')).rejects.toThrow();
  });

  it('throws a 400 on invalid input instead of leaking a Zod error', async () => {
    const { di } = fakeDi();
    const svc = new SettingsService(di);
    await expect(svc.set('email.smtp', { host: '', port: 'nope', username: '' }, 'u1'))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('includes the group description in the masked payload', async () => {
    const { di } = fakeDi();
    const svc = new SettingsService(di);
    const masked = await svc.getMasked('security.rateLimit');
    expect(masked.description).toContain('Max requests per client');
  });

  // A field added to a group after a row was written is absent from that row.
  // The env fallback used to apply only when the whole row was missing, so the
  // new field read as unset and its environment variable was silently ignored.
  describe('a field added to an already-saved group', () => {
    function withRow(key: string, value: Record<string, unknown>) {
      const store: Record<string, any> = { [key]: { key, value } };
      return {
        di: {
          prisma: {
            user: { findUnique: async () => null },
            appSetting: {
              findUnique: async ({ where }: any) => store[where.key] ?? null,
              upsert: async ({ where, create, update }: any) => {
                store[where.key] = { key: where.key, ...(store[where.key] || create), ...update };
                return store[where.key];
              },
              deleteMany: async ({ where }: any) => {
                const count = store[where.key] ? 1 : 0;
                delete store[where.key];
                return { count };
              },
            },
          },
        } as any,
        store,
      };
    }

    it('reads the env fallback for keys the stored row does not carry', async () => {
      process.env.REST_RPC_SECURITY_DEFINER = 'rpc_all_widgets';
      // A row written before `rpcSecurityDefiner` existed on the group.
      const { di } = withRow('api.rest', { maxRows: 250 });
      const svc = new SettingsService(di);

      const cfg = await svc.get<any>('api.rest');
      expect(cfg.maxRows).toBe(250);            // the stored value still wins
      expect(cfg.rpcSecurityDefiner).toBe('rpc_all_widgets');  // and env fills the gap
      delete process.env.REST_RPC_SECURITY_DEFINER;
    });

    it('lets a stored empty value override the env instead of falling back to it', async () => {
      process.env.REST_RPC_SECURITY_DEFINER = 'rpc_all_widgets';
      const { di } = withRow('api.rest', { maxRows: 1000, rpcSecurityDefiner: '' });
      const svc = new SettingsService(di);

      // Explicitly cleared in Studio: clearing has to mean cleared, or the
      // allowlist could never be emptied without an env edit and a restart.
      expect((await svc.get<any>('api.rest')).rpcSecurityDefiner).toBe('');
      delete process.env.REST_RPC_SECURITY_DEFINER;
    });
  });

  describe('api.rest rpcSecurityDefiner', () => {
    it('round-trips through set/get instead of being stripped by the schema', async () => {
      const { di } = fakeDi();
      const svc = new SettingsService(di);
      await svc.set('api.rest', { maxRows: 1000, rpcSecurityDefiner: 'rpc_a, rpc_b' }, 'user-1');
      expect((await svc.get<any>('api.rest')).rpcSecurityDefiner).toBe('rpc_a,rpc_b');
    });

    it('preserves case, because a quoted "MyFn" is a different function from myfn', async () => {
      const { di } = fakeDi();
      const svc = new SettingsService(di);
      await svc.set('api.rest', { maxRows: 1000, rpcSecurityDefiner: 'MyFn' }, 'user-1');
      expect((await svc.get<any>('api.rest')).rpcSecurityDefiner).toBe('MyFn');
    });

    it('drops blanks and duplicates', async () => {
      const { di } = fakeDi();
      const svc = new SettingsService(di);
      await svc.set('api.rest', { maxRows: 1000, rpcSecurityDefiner: ' a , , a ,b ' }, 'user-1');
      expect((await svc.get<any>('api.rest')).rpcSecurityDefiner).toBe('a,b');
    });

    it('rejects entries that could never be a function name', async () => {
      const { di } = fakeDi();
      const svc = new SettingsService(di);
      await expect(svc.set('api.rest', { maxRows: 1000, rpcSecurityDefiner: 'x'.repeat(64) }, 'user-1'))
        .rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
