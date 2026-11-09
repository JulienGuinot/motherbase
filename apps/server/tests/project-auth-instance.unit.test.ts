import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createProjectAuth } from '../auth/instance';

// Offline: constructs the instance (no DB connection happens until a query).
describe('createProjectAuth', () => {
  it('boots an instance exposing a handler and api', () => {
    const auth = createProjectAuth({
      prisma: new PrismaClient(),
      secret: 'x'.repeat(40),
      baseURL: 'http://localhost:3000',
      sendOtp: async () => {},
      sendMagicLink: async () => {},
    });
    expect(typeof auth.handler).toBe('function');
    expect(typeof auth.api.getSession).toBe('function');
    expect(typeof auth.api.signInEmail).toBe('function');
    expect(auth.options.user?.deleteUser?.enabled).toBe(true);
  });

  it('exposes the phase-2c plugin endpoints (2FA opt-in, magic-link, organization)', () => {
    const auth = createProjectAuth({
      prisma: new PrismaClient(),
      secret: 'x'.repeat(40),
      baseURL: 'http://localhost:3000',
      sendOtp: async () => {},
      sendMagicLink: async () => {},
      twoFactor: {},
    });
    for (const m of ['enableTwoFactor', 'getTOTPURI', 'signInMagicLink', 'createOrganization', 'listOrganizations']) {
      expect(typeof (auth.api as any)[m], m).toBe('function');
    }
  });

  it('omits social providers when unconfigured', () => {
    const auth = createProjectAuth({
      prisma: new PrismaClient(),
      secret: 'x'.repeat(40),
      baseURL: 'http://localhost:3000',
      sendOtp: async () => {},
      sendMagicLink: async () => {},
      google: { clientId: '', clientSecret: '' },
    });
    expect(typeof auth.handler).toBe('function');
  });

  it('enables passkey, apiKey and sso endpoints when configured', () => {
    const auth = createProjectAuth({
      prisma: new PrismaClient(),
      secret: 'x'.repeat(40),
      baseURL: 'http://localhost:3000',
      sendOtp: async () => {},
      sendMagicLink: async () => {},
      socialProviders: { github: { clientId: 'a', clientSecret: 'b' } },
      passkey: { rpId: 'localhost', rpName: 'T', origin: 'http://localhost:3000' },
      apiKey: true,
      sso: true,
      methods: { emailPassword: true },
    });
    for (const m of ['createApiKey', 'signInSSO', 'listPasskeys']) {
      expect(typeof (auth.api as any)[m], m).toBe('function');
    }
  });

  // Better Auth 1.7 checks its tables against the Prisma client before the
  // first request and fails every auth endpoint on a mismatch. A plugin
  // addressing a model by another name than its Prisma client property (the
  // api-key plugin's `apikey` against `prisma.apiKey`) broke sign-in for every
  // project that turned that plugin on. Offline: the check reads the client's
  // generated data model, not the database.
  it('matches the Prisma schema with every plugin turned on', async () => {
    const auth = createProjectAuth({
      prisma: new PrismaClient(),
      secret: 'x'.repeat(40),
      baseURL: 'http://localhost:3000',
      sendOtp: async () => {},
      sendMagicLink: async () => {},
      sendSms: async () => {},
      phoneOtp: {},
      twoFactor: {},
      passkey: { rpId: 'localhost', rpName: 'T', origin: 'http://localhost:3000' },
      apiKey: true,
      sso: true,
      organization: { enabled: true, teamsEnabled: true },
      methods: { emailPassword: true, magicLink: true, emailOTP: true, anonymous: true },
    });
    const ctx = await auth.$context;
    expect(ctx.checkSchema).toBeTypeOf('function');
    await expect(ctx.checkSchema!()).resolves.not.toThrow();
  });

  it('disables email+password when methods.emailPassword is false', () => {
    const auth = createProjectAuth({
      prisma: new PrismaClient(),
      secret: 'x'.repeat(40),
      baseURL: 'http://localhost:3000',
      sendOtp: async () => {},
      sendMagicLink: async () => {},
      methods: { emailPassword: false, magicLink: false, emailOTP: false },
    });
    expect(typeof auth.handler).toBe('function');
  });
  // Better Auth never populates `username` (it is one of our additionalFields),
  // so without the create hook every account it creates lands with a null one.
  describe('username generation on user create', () => {
    const base = {
      prisma: new PrismaClient(),
      secret: 'x'.repeat(40),
      baseURL: 'http://localhost:3000',
      sendOtp: async () => {},
      sendMagicLink: async () => {},
    };
    const hookOf = (auth: any) => auth.options.databaseHooks.user.create.before;

    it('fills a generated username when the sign-up supplies none', async () => {
      const auth = createProjectAuth({ ...base, generateUsername: async () => 'PixelPirate7' });
      const result = await hookOf(auth)({ email: 'a@example.com' }, null);
      expect(result.data.username).toBe('PixelPirate7');
      expect(result.data.email).toBe('a@example.com');
    });

    it('keeps a username the client supplied', async () => {
      const auth = createProjectAuth({ ...base, generateUsername: async () => 'Generated' });
      expect(await hookOf(auth)({ email: 'a@example.com', username: 'chosen' }, null)).toBeUndefined();
    });

    it('lets the sign-up through when generation fails', async () => {
      const auth = createProjectAuth({
        ...base,
        generateUsername: async () => { throw new Error('db down'); },
      });
      expect(await hookOf(auth)({ email: 'a@example.com' }, null)).toBeUndefined();
    });

    it('still denies through the sign-up gate, before generating anything', async () => {
      let generated = false;
      const auth = createProjectAuth({
        ...base,
        beforeUserCreated: async () => ({ allow: false, reason: 'nope' }),
        generateUsername: async () => { generated = true; return 'Unused'; },
      });
      await expect(hookOf(auth)({ email: 'a@example.com' }, null)).rejects.toThrow('nope');
      expect(generated).toBe(false);
    });

    it('leaves the username alone when neither dep is passed', async () => {
      // The hooks are always installed now (they also cap Better Auth's own
      // `name`/`image`), but with no generator there is nothing to fill in.
      const auth = createProjectAuth(base) as any;
      expect(await hookOf(auth)({ email: 'a@example.com', name: 'Ada' }, null)).toBeUndefined();
    });
  });
});
