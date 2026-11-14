import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware, getIP, getSessionFromCtx } from 'better-auth/api';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import {
  anonymous,
  captcha,
  emailOTP,
  haveIBeenPwned,
  bearer,
  jwt,
  twoFactor,
  magicLink,
  organization,
  genericOAuth,
  phoneNumber,
} from 'better-auth/plugins';
import { sso } from '@better-auth/sso';
import { passkey } from '@better-auth/passkey';
import { apiKey } from '@better-auth/api-key';
import type { PrismaClient } from '@prisma/client';
import { hashPassword, verifyPassword } from './password';
import { orgFullMessage, orgHasRoomForMember, orgSeatLimit } from './org-limits';
import { DEFAULT_SIGNING_ALGORITHM, signingKeyAdapter } from './signing-keys';
import { isServerSideSessionRead } from './server-session';
import {
  accessTokenClaims as dataPlaneClaims,
  datingAccessTokens,
  invalidateSigningKeys,
  revokeAccessTokens,
} from './access-tokens';
import { userCredentials } from './plugins/user-credentials';
import { pkceExchange } from './plugins/pkce-exchange';
import { PhoneOtpStore } from './phone-otp-store';
import {
  DEFAULT_TO_SITE_URL_PATHS,
  enforceRedirects,
  redirectOrigins,
  redirectsConfigured,
  type RedirectConfig,
} from './redirect-urls';
import {
  capCoreProfileFields,
  discardsWrittenName,
  personNameSchema,
  usernameSchema,
} from '../validators/user-fields';

// Confirmed against better-auth@1.6.23:
// - prismaAdapter(prisma, { provider: 'postgresql' }) from better-auth/adapters/prisma
// - emailOTP / bearer / jwt / twoFactor / magicLink / organization / genericOAuth
//   from better-auth/plugins
// - anonymous (Supabase "anonymous sign-ins") is mounted only when enabled in
//   auth.methods. It sends `isAnonymous` on user create, hence that column on
//   auth.users.
// - passkey / sso / apiKey ship as separate packages in this version line
//   (@better-auth/passkey, @better-auth/sso, @better-auth/api-key)
// - emailAndPassword.password.{hash,verify} custom hooks (argon2 + bcrypt compat)
//
// The instance is config-driven: providers and plugins are assembled from the
// deps object (which AuthManager fills from the auth.* settings groups) rather than
// hardcoded. Construction opens no DB connection (queries happen lazily per
// request) so it is cheap to rebuild on a live settings change.

export interface OtpArgs {
  email: string;
  otp: string;
  type: 'sign-in' | 'email-verification' | 'forget-password' | 'change-email';
}

/** One fully custom OIDC/OAuth2 provider fed to the genericOAuth plugin. */
export interface GenericOAuthConfig {
  providerId: string;
  clientId: string;
  clientSecret?: string;
  discoveryUrl?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  scopes?: string[];
}


/** Where Better Auth's haveibeenpwned plugin checks a new password: its own
 *  defaults, plus this project's GoTrue `PUT /user` equivalent. */
export const PASSWORD_SET_PATHS = [
  '/sign-up/email',
  '/change-password',
  '/reset-password',
  '/email-otp/reset-password',
  '/phone-number/reset-password',
  '/update-user-credentials',
];

/** What the after-hook knows about one processed auth request. */
export interface AuthRequestInfo {
  path: string;
  userId?: string | null;
  /** The user's email, or the one the request named (a recovery request has no session). */
  email?: string | null;
  ip?: string | null;
  /** The failure message when the endpoint answered with one. */
  error?: string | null;
}

export interface ProjectAuthDeps {
  prisma: PrismaClient;
  secret: string;
  baseURL: string;
  /** Extra origins allowed to call auth endpoints (CSRF check). baseURL is always trusted. */
  trustedOrigins?: string[];
  /** Supabase URL Configuration: Site URL + redirect allowlist. Absent/empty = not enforced. */
  redirects?: RedirectConfig;
  /** Attributes merged into every auth cookie. Set by AuthManager to SameSite=None
   *  when a cross-site frontend is trusted (see crossSiteCookieAttributes). */
  cookieAttributes?: { sameSite: 'none'; secure: true };
  /** Delivers a one-time code by email (wraps TransporterService). */
  sendOtp: (args: OtpArgs) => Promise<void>;
  /** Delivers an email-verification link by email. Absent = fall back to magic-link delivery. */
  sendVerificationLink?: (args: { email: string; url: string }) => Promise<void>;
  /** Delivers a magic-link sign-in URL by email. */
  sendMagicLink: (args: { email: string; url: string }) => Promise<void>;
  /** Delivers a one-time code by SMS (wraps SmsService). Required when phoneOtp is set. */
  sendSms?: (args: { phoneNumber: string; code: string }) => Promise<void>;
  /** Phone / SMS sign-in behaviour. Absent = phone auth disabled. */
  phoneOtp?: {
    otpLength?: number;
    expiresIn?: number;
    signUpOnVerification?: boolean;
    /** Numbers that skip the real SMS provider and accept a fixed code, e.g. for app-store review. */
    testNumbers?: Record<string, string>;
  };
  /** Assembled, enabled-only social provider map (providerId → { clientId, clientSecret, ... }). */
  socialProviders?: Record<string, any>;
  /** Fully custom OIDC/OAuth2 providers. */
  genericOAuth?: GenericOAuthConfig[];
  /** Non-social sign-in method toggles. Absent keys default on, except
   *  `anonymous`, which defaults off as it does in Supabase. */
  methods?: { emailPassword?: boolean; magicLink?: boolean; emailOTP?: boolean; anonymous?: boolean };
  /** Mails the `reauthenticate()` nonce. Absent = the endpoint answers 500 on use. */
  sendReauthenticationNonce?: (args: { email: string; nonce: string }) => Promise<void>;
  /** Registration + password policy. Absent = open signup, no verification, 8..128 length. */
  signup?: {
    allowNewUsers?: boolean;
    requireEmailVerification?: boolean;
    autoSignInAfterVerify?: boolean;
    minPasswordLength?: number;
    maxPasswordLength?: number;
  };
  /** Session refresh/freshness/revocation behaviour. Absent = defaults. */
  sessions?: {
    revokeOnPasswordReset?: boolean;
    disableRefresh?: boolean;
    updateAgeHours?: number;
    freshAgeMinutes?: number;
  };
  /** JWT access-token and persistent Better Auth session lifetimes. */
  tokens?: { accessTokenExpMin: number; refreshTokenExpDays: number };
  twoFactor?: {
    issuer?: string;
    totpDigits?: number;
    totpPeriod?: number;
    otpChannel?: 'off' | 'email' | 'sms';
    otpDigits?: number;
    otpPeriodMinutes?: number;
    backupCodeCount?: number;
    backupCodeLength?: number;
    trustDeviceDays?: number;
  };
  /** Delivers a 2FA OTP over the configured channel (email or SMS). Required when
   *  twoFactor.otpChannel is 'email' or 'sms'. */
  sendTwoFactorOtp?: (args: { user: { email?: string; phoneNumber?: string | null }; otp: string }) => Promise<void>;
  /** "Before user created" gate. Returns a verdict; a deny aborts the sign-up with
   *  a 403. Absent = no gate. */
  beforeUserCreated?: (user: { email?: string | null }) => Promise<{ allow: boolean; reason?: string }>;
  /** Produces a free username for a sign-up that did not supply one. Better Auth
   *  never sets `username` itself, so without this every account created through
   *  it lands with a null username. Absent = leave the column null. */
  generateUsername?: () => Promise<string>;
  /** "Custom access token" hook: extra JWT claims derived from the signed-in user.
   *  Absent = no extra claims. */
  accessTokenClaims?: (user: Record<string, unknown>) => Record<string, unknown>;
  /** Fire-and-forget notification after each processed auth request (for the auth
   *  event webhook and the Logs stream). Must never throw. Absent = no notification.
   *  `error` carries the failure message when the endpoint answered with one. */
  onAuthRequest?: (info: AuthRequestInfo) => void;
  passkey?: { rpId?: string; rpName?: string; origin?: string };
  /** Supabase Attack Protection: CAPTCHA on the chosen auth endpoints. Absent = off. */
  captcha?: { provider: 'hcaptcha' | 'turnstile'; secretKey: string; siteKey?: string; endpoints: string[] };
  /** Reject passwords found in HaveIBeenPwned (k-anonymity range query). */
  leakedPasswordProtection?: boolean;
  apiKey?: boolean;
  sso?: boolean;
  organization?: {
    enabled?: boolean;
    allowUserToCreateOrganization?: boolean;
    /** Better Auth team sub-groups. Formerly (and wrongly) called `allowOrgSso`. */
    teamsEnabled?: boolean;
    /** Maximum members per organization. 0 / absent = unlimited. */
    maxMembers?: number;
  };
  // Legacy single-provider deps, still accepted and merged into socialProviders.
  google?: { clientId: string; clientSecret: string };
  apple?: { clientId: string; clientSecret: string; appBundleIdentifier?: string };
}

/** Google's `given_name` / `family_name` onto the structured name fields. Better
 *  Auth already maps `picture` onto `image` and `name` onto `name`. */
export function mapGoogleProfileToUser(profile: {
  given_name?: string;
  family_name?: string;
}) {
  return {
    firstName: profile.given_name || undefined,
    lastName: profile.family_name || undefined,
  };
}

/** The request-level half of AuthRequestInfo. */
function requestInfo(ctx: { path: string; request?: Request; context: { options: any } }): Pick<AuthRequestInfo, 'path' | 'ip'> {
  return { path: ctx.path, ip: ctx.request ? getIP(ctx.request, ctx.context.options) : null };
}

function buildSocialProviders(deps: ProjectAuthDeps): Record<string, any> {
  const socialProviders: Record<string, any> = { ...(deps.socialProviders ?? {}) };
  if (deps.google?.clientId && deps.google?.clientSecret) {
    socialProviders.google = { clientId: deps.google.clientId, clientSecret: deps.google.clientSecret, ...socialProviders.google };
  }
  if (deps.apple?.clientId && deps.apple?.clientSecret) {
    socialProviders.apple = {
      clientId: deps.apple.clientId,
      clientSecret: deps.apple.clientSecret,
      appBundleIdentifier: deps.apple.appBundleIdentifier,
      ...socialProviders.apple,
    };
  }

  // Better Auth maps the avatar onto `user.image` itself; this adds the
  // structured names Google already hands us.
  //
  // Deliberately no `overrideUserInfoOnSignIn`: the app lets a user upload their
  // own avatar (UserService.updateImage), and re-running this on every sign-in
  // would stomp it back to the Google one.
  if (socialProviders.google) {
    socialProviders.google = { mapProfileToUser: mapGoogleProfileToUser, ...socialProviders.google };
  }
  return socialProviders;
}

function resolveSessions(deps: ProjectAuthDeps) {
  const sessions = {
    revokeOnPasswordReset: true,
    disableRefresh: false,
    updateAgeHours: 24,
    freshAgeMinutes: 0,
    ...(deps.sessions ?? {}),
  };
  const sessionConfig: {
    expiresIn?: number;
    disableSessionRefresh?: boolean;
    updateAge?: number;
    freshAge: number;
  } = {
    ...(deps.tokens && { expiresIn: deps.tokens.refreshTokenExpDays * 86_400 }),
    ...(sessions.disableRefresh ? { disableSessionRefresh: true } : { updateAge: sessions.updateAgeHours * 3_600 }),
    // freshAge 0 disables the freshness requirement in Better Auth.
    freshAge: sessions.freshAgeMinutes * 60,
  };
  return { sessions, sessionConfig };
}

type AuthMethods = Required<NonNullable<ProjectAuthDeps['methods']>>;

function buildPlugins(deps: ProjectAuthDeps, methods: AuthMethods): any[] {
  const plugins: any[] = [];
  if (methods.emailOTP) {
    plugins.push(
      emailOTP({
        async sendVerificationOTP({ email, otp, type }) {
          await deps.sendOtp({ email, otp, type });
        },
      }),
    );
  }
  if (methods.magicLink) {
    plugins.push(
      magicLink({
        async sendMagicLink({ email, url }) {
          await deps.sendMagicLink({ email, url });
        },
      }),
    );
  }
  if (methods.anonymous) {
    plugins.push(
      anonymous({
        // `.invalid` is reserved (RFC 2606) and can never receive mail. The
        // plugin's default, `temp@<id>.com`, is a real-looking domain.
        emailDomainName: 'anonymous.invalid',
        // Supabase keeps the guest when it then signs into an existing account;
        // Better Auth would delete it, and its rows with it (FK cascade).
        disableDeleteAnonymousUser: true,
      }),
    );
  }
  plugins.push(
    userCredentials({
      sendNonce: async args => {
        if (!deps.sendReauthenticationNonce) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Email delivery is not configured.' });
        await deps.sendReauthenticationNonce(args);
      },
    }),
  );
  plugins.push(pkceExchange(deps.prisma));
  if (deps.phoneOtp && deps.sendSms) plugins.push(phoneNumberPlugin(deps.phoneOtp, deps.sendSms));
  if (deps.twoFactor) plugins.push(twoFactorPlugin(deps.twoFactor, deps.sendTwoFactorOtp));
  if (deps.captcha) {
    const { provider, secretKey, siteKey, endpoints } = deps.captcha;
    plugins.push(
      provider === 'turnstile'
        ? captcha({ provider: 'cloudflare-turnstile', secretKey, endpoints })
        : captcha({ provider: 'hcaptcha', secretKey, siteKey: siteKey || undefined, endpoints }),
    );
  }
  if (deps.leakedPasswordProtection) plugins.push(haveIBeenPwned({ paths: PASSWORD_SET_PATHS }));
  if (deps.passkey) {
    plugins.push(passkey({ rpID: deps.passkey.rpId, rpName: deps.passkey.rpName, origin: deps.passkey.origin }));
  }
  // The plugin addresses its table as `apikey`; the Prisma client exposes the
  // `ApiKey` model as `prisma.apiKey`. Better Auth 1.7 checks that every table
  // it writes exists on the client and fails all of auth when one does not.
  if (deps.apiKey) plugins.push(apiKey({ schema: { apikey: { modelName: 'apiKey' } } }));
  if (deps.sso) plugins.push(ssoPlugin(deps.prisma, deps.organization?.maxMembers));
  if (deps.genericOAuth?.length) {
    plugins.push(
      genericOAuth({
        config: deps.genericOAuth.map(p => ({
          providerId: p.providerId,
          clientId: p.clientId,
          clientSecret: p.clientSecret ?? '',
          discoveryUrl: p.discoveryUrl || undefined,
          authorizationUrl: p.authorizationUrl || undefined,
          tokenUrl: p.tokenUrl || undefined,
          userInfoUrl: p.userInfoUrl || undefined,
          scopes: p.scopes?.length ? p.scopes : undefined,
        })),
      }),
    );
  }
  if (deps.organization?.enabled !== false) {
    plugins.push(
      organization({
        allowUserToCreateOrganization: deps.organization?.allowUserToCreateOrganization ?? true,
        // Enforces the seat cap on BOTH add-member and accept-invitation (see
        // better-auth's crud-members / crud-invites). Passed as a function on
        // purpose: better-auth also reuses a *numeric* membershipLimit as the
        // listMembers page size, and a function leaves that at its existing 100.
        membershipLimit: () => orgSeatLimit(deps.organization?.maxMembers),
        ...(deps.organization?.teamsEnabled ? { teams: { enabled: true } } : {}),
      }),
    );
  }
  plugins.push(bearer());
  plugins.push(jwtPlugin(deps.prisma, deps.tokens, deps.accessTokenClaims));
  return plugins;
}

function phoneNumberPlugin(
  phoneOtp: NonNullable<ProjectAuthDeps['phoneOtp']>,
  sendSms: NonNullable<ProjectAuthDeps['sendSms']>,
) {
  const testNumbers = phoneOtp.testNumbers ?? {};
  // The internal OTP store the plugin would otherwise keep, kept here instead
  // because a test number's verifyOTP call must still succeed without one ever
  // being sent: the fixed code is compared directly against config, but a
  // real number's code still has to round-trip through *something* once
  // verifyOTP fully replaces the plugin's default (all-or-nothing) check.
  const issued = new PhoneOtpStore((phoneOtp.expiresIn ?? 300) * 1000);
  return phoneNumber({
    sendOTP: async ({ phoneNumber: to, code }) => {
      if (testNumbers[to]) return; // Fixed code, no real SMS.
      issued.issue(to, code);
      await sendSms({ phoneNumber: to, code });
    },
    verifyOTP: async ({ phoneNumber: to, code }) => {
      if (testNumbers[to]) return testNumbers[to] === code;
      return issued.verify(to, code);
    },
    otpLength: phoneOtp.otpLength,
    expiresIn: phoneOtp.expiresIn,
    signUpOnVerification: phoneOtp.signUpOnVerification
      ? {
          // User.email is a required unique column, so a phone-only sign-up
          // needs a stand-in email until the user attaches a real one.
          getTempEmail: (phone: string) => `${phone.replace(/[^0-9]/g, '')}@phone.local`,
          getTempName: (phone: string) => phone,
        }
      : undefined,
  });
}

function twoFactorPlugin(
  tf: NonNullable<ProjectAuthDeps['twoFactor']>,
  sendOtp: ProjectAuthDeps['sendTwoFactorOtp'],
) {
  const otpSender = tf.otpChannel === 'email' || tf.otpChannel === 'sms' ? sendOtp : undefined;
  return twoFactor({
    ...(tf.issuer ? { issuer: tf.issuer } : {}),
    totpOptions: {
      digits: (tf.totpDigits === 8 ? 8 : 6) as 6 | 8,
      period: tf.totpPeriod ?? 30,
    },
    backupCodeOptions: {
      amount: tf.backupCodeCount ?? 10,
      length: tf.backupCodeLength ?? 10,
    },
    trustDeviceMaxAge: (tf.trustDeviceDays ?? 30) * 86400,
    ...(otpSender
      ? {
          otpOptions: {
            digits: tf.otpDigits ?? 6,
            period: tf.otpPeriodMinutes ?? 3,
            sendOTP: async ({ user, otp }) => {
              await otpSender({ user, otp });
            },
          },
        }
      : {}),
  });
}

/**
 * SSO auto-provisioning writes the `member` row through the raw adapter, so it is
 * the one join path the organization plugin's membershipLimit never sees. getRole
 * is the only hook that runs before that write.
 */
function ssoPlugin(prisma: PrismaClient, maxMembers: number | undefined) {
  return sso({
    organizationProvisioning: {
      getRole: async ({ provider }: { provider: { organizationId?: string | null } }) => {
        const organizationId = provider?.organizationId;
        if (organizationId) {
          const count = await prisma.member.count({ where: { organizationId } });
          if (!orgHasRoomForMember(count, maxMembers)) {
            throw new APIError('FORBIDDEN', { message: orgFullMessage(maxMembers) });
          }
        }
        return 'member';
      },
    },
  });
}

function jwtPlugin(
  prisma: PrismaClient,
  tokens: ProjectAuthDeps['tokens'],
  accessTokenClaims: ProjectAuthDeps['accessTokenClaims'],
) {
  return jwt({
    // No `set-auth-jwt` header for a session this server reads for itself: see
    // auth/server-session.ts. A getter, because the plugin reads it per call.
    get disableSettingJwtHeader() {
      return isServerSideSessionRead();
    },
    // New keys are ES256, Supabase's default. Existing keys keep their own
    // algorithm: each row records it (auth/signing-keys.ts).
    // Self-hosted with a trusted DB: the JWKS private key is stored unencrypted so
    // it is not coupled to the auth secret, which would make existing keys
    // undecryptable on rotation.
    jwks: { disablePrivateKeyEncryption: true, keyPairConfig: { alg: DEFAULT_SIGNING_ALGORITHM } },
    // Which key signs is decided by the signing-key lifecycle, not by age.
    adapter: signingKeyAdapter(prisma, invalidateSigningKeys),
    jwt: {
      ...(tokens ? { expirationTime: `${tokens.accessTokenExpMin}m` } : {}),
      // The claims the data plane reads ride on every token, whatever the
      // custom-claims hook adds (or replaces the user with): `is_anonymous`
      // is a Supabase standard claim, and the rest is what lets a request be
      // served from the token alone (auth/access-tokens.ts).
      definePayload: ({ user }: { user: Record<string, unknown> }) => ({
        ...(accessTokenClaims ? accessTokenClaims(user) : user),
        ...dataPlaneClaims(user),
      }),
    },
  });
}

/**
 * Mirrored by the SDK's `MOTHERBASE_USER_FIELDS` (packages/client), which types
 * `client.auth.updateUser`; tests/user-fields-contract.unit.test.ts keeps the
 * two in step.
 */
export const USER_ADDITIONAL_FIELDS = {
  // `input: true` means a client can set these on sign-up and through
  // `POST /api/auth/update-user`, so every one of them needs a validator:
  // Better Auth applies no length or shape check of its own, and without
  // this a 500-character username went straight into the column.
  username: { type: 'string', required: false, input: true, validator: { input: usernameSchema } },
  // Writing either rewrites `name` (the users_derive_name trigger).
  firstName: { type: 'string', required: false, input: true, validator: { input: personNameSchema } },
  lastName: { type: 'string', required: false, input: true, validator: { input: personNameSchema } },
  role: { type: 'string', required: false, defaultValue: 'USER', input: false },
  // Declared here as well as by the anonymous plugin so it is on every
  // session user even while that plugin is off: the `is_anonymous` claim
  // and the guest checks in plugins/user-credentials.ts read it.
  isAnonymous: { type: 'boolean', required: false, defaultValue: false, input: false },
  status: { type: 'string', required: false, defaultValue: 'active', input: false },
} as const;

/** Before: sign-out reporting and redirect enforcement. After: aal2 marking and auth-event notification. */
function authHooks(deps: ProjectAuthDeps) {
  const redirects = deps.redirects;
  return {
    before: createAuthMiddleware(async ctx => {
      // Sign-out deletes the session before any after-hook runs, so its
      // owner is only knowable up front. Reported here, where it still is.
      if (deps.onAuthRequest && ctx.path === '/sign-out') {
        try {
          const session = await getSessionFromCtx(ctx, { disableRefresh: true });
          if (session) deps.onAuthRequest({ ...requestInfo(ctx), userId: session.user.id, email: session.user.email });
        } catch {
          /* never let a notification break the response */
        }
      }
      // URL Configuration: every redirect field of every endpoint, body or
      // query, so a flow added later cannot skip it.
      if (redirectsConfigured(redirects)) {
        const defaultCallback = DEFAULT_TO_SITE_URL_PATHS.includes(ctx.path);
        const body = enforceRedirects(ctx.body as Record<string, unknown> | undefined, redirects, { defaultCallback });
        const query = enforceRedirects(ctx.query as Record<string, unknown> | undefined, redirects);
        if (body || query) return { context: { ...(body ? { body } : {}), ...(query ? { query } : {}) } };
      }
    }),
    after: createAuthMiddleware(async ctx => {
      // A second factor just passed: this session is now aal2, which is
      // what mfa.getAuthenticatorAssuranceLevel() reports.
      const newSession = (ctx.context as any)?.newSession?.session;
      if (ctx.path.startsWith('/two-factor/verify-') && newSession?.id) {
        await deps.prisma.session.update({ where: { id: newSession.id }, data: { aal: 'aal2' } }).catch(() => {});
      }
      // Fire-and-forget auth-event notification. AuthManager decides which
      // paths emit and dispatches the webhook; this never blocks or throws.
      if (!deps.onAuthRequest || ctx.path === '/sign-out') return;
      try {
        const user = (ctx.context as any)?.newSession?.user ?? (ctx.context as any)?.session?.user;
        // A rejected endpoint returns an APIError rather than throwing out
        // of the middleware chain, so a failed sign-in is only detectable
        // here: the after-hook runs for successes and failures alike.
        const returned = (ctx.context as any)?.returned;
        const error =
          returned instanceof APIError
            ? String((returned as any)?.body?.message ?? (returned as any)?.message ?? 'rejected')
            : null;
        const bodyEmail = typeof (ctx.body as any)?.email === 'string' ? (ctx.body as any).email : null;
        deps.onAuthRequest({ ...requestInfo(ctx), userId: user?.id ?? null, email: user?.email ?? bodyEmail, error });
      } catch {
        /* never let a notification break the response */
      }
    }),
  };
}

function databaseHooks(deps: ProjectAuthDeps): BetterAuthOptions['databaseHooks'] {
  return {
    account: {
      create: {
        // A guest that gains any real identity (a linked provider, or the
        // password set after an email) is no longer anonymous. The same row,
        // the same id, so everything it owned stays owned.
        after: async account => {
          const { count } = await deps.prisma.user.updateMany({
            where: { id: account.userId, isAnonymous: true },
            data: { isAnonymous: false },
          });
          if (count) revokeAccessTokens(account.userId);
        },
      },
    },
    // Access tokens outlive the request that minted them, so whatever ends a
    // session or changes what a token says about its user refuses the tokens
    // already out (auth/access-tokens.ts). These run after the write is
    // committed, for every Better Auth flow: sign-out, revoke-session(s), a
    // password reset that revokes sessions, update-user, delete-user.
    session: {
      delete: { after: async session => revokeAccessTokens(session.userId) },
    },
    user: {
      delete: { after: async user => revokeAccessTokens(user.id) },
      update: {
        after: async user => revokeAccessTokens(user.id),
        // Better Auth's own `name`/`image` columns take no validator (they are
        // not additionalFields), and update-user accepts any string for them.
        //
        // `name` is derived from firstName/lastName by a trigger, so a client
        // setting `name` alone on a user who has either would get a 200 for a
        // name that is never stored. Only update-user is checked: the internal
        // flows that write `name` must not start failing on it.
        before: async (user, ctx) => {
          const userId = ctx?.path === '/update-user' ? ctx.context.session?.user.id : undefined;
          if (userId && typeof user.name === 'string') {
            const current = await deps.prisma.user.findUnique({
              where: { id: userId },
              select: { firstName: true, lastName: true },
            });
            if (current && discardsWrittenName(user, current)) {
              throw new APIError('BAD_REQUEST', {
                message: 'name is derived from firstName and lastName on this user: update those, or clear them to set name directly.',
              });
            }
          }
          const capped = capCoreProfileFields(user);
          return capped ? { data: { ...user, ...capped } } : undefined;
        },
      },
      create: {
        // Runs before any row is written. Three jobs, in order:
        //   1. the Supabase-style "before user created" gate - a deny aborts
        //      the sign-up with a 403;
        //   2. capping Better Auth's own `name`/`image`, which arrive
        //      unbounded from both update-user and OAuth profiles;
        //   3. filling `username`, which Better Auth never sets itself
        //      (it is one of our additionalFields, only populated when a
        //      client sends one), so an account created through any auth
        //      method still gets the generated name the app expects.
        before: async user => {
          if (deps.beforeUserCreated) {
            const verdict = await deps.beforeUserCreated(user);
            if (!verdict.allow) {
              throw new APIError('FORBIDDEN', { message: verdict.reason || 'Sign-up not allowed.' });
            }
          }

          const capped = capCoreProfileFields(user) ?? {};

          const supplied = typeof user.username === 'string' ? user.username.trim() : '';
          if (supplied || !deps.generateUsername) {
            return Object.keys(capped).length > 0 ? { data: { ...user, ...capped } } : undefined;
          }

          // A failure here must not cost the user their sign-up: the
          // column is nullable, so fall through with it unset.
          // ponytail: generate-then-insert, so two simultaneous sign-ups
          // can still pick the same name and one hits the unique index.
          // Retry inside generateUsername if that ever shows up in logs.
          try {
            return { data: { ...user, ...capped, username: await deps.generateUsername() } };
          } catch {
            return Object.keys(capped).length > 0 ? { data: { ...user, ...capped } } : undefined;
          }
        },
      },
    },
  };
}

/**
 * When verification gates sign-in, better-auth needs a way to send the link.
 * Core email verification is LINK-based (visit `url` to verify). There is no
 * "enter a code" API here, so this must NOT be routed through deps.sendOtp.
 */
function emailVerification(deps: ProjectAuthDeps, autoSignIn: boolean) {
  return {
    sendOnSignUp: true,
    autoSignInAfterVerification: autoSignIn,
    sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
      const send = deps.sendVerificationLink ?? deps.sendMagicLink;
      await send({ email: user.email, url });
    },
  };
}

export function createProjectAuth(deps: ProjectAuthDeps) {
  const methods = { emailPassword: true, magicLink: true, emailOTP: true, anonymous: false, ...(deps.methods ?? {}) };
  const signup = {
    allowNewUsers: true,
    requireEmailVerification: false,
    autoSignInAfterVerify: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    ...(deps.signup ?? {}),
  };
  const { sessions, sessionConfig } = resolveSessions(deps);
  const verifiesEmail = methods.emailPassword && signup.requireEmailVerification;
  // Better Auth checks a callback's origin against trustedOrigins before any
  // hook runs, so an allowlisted redirect has to be trusted there as well.
  const trustedOrigins = [
    ...(deps.trustedOrigins ?? []),
    ...(redirectsConfigured(deps.redirects) ? redirectOrigins(deps.redirects) : []),
  ];

  const auth = betterAuth({
    database: prismaAdapter(deps.prisma, { provider: 'postgresql' }),
    secret: deps.secret,
    baseURL: deps.baseURL,
    basePath: '/api/auth',
    // Secure cookies follow the actual scheme, not NODE_ENV: dev project stacks
    // run the production build over http://<name>.localhost, and a browser drops
    // a `__Secure-`/`Secure` cookie on plain http: sign-up then returns 200 with
    // no session stored, which looks like "register does nothing".
    advanced: {
      useSecureCookies: deps.baseURL.startsWith('https://'),
      ...(deps.cookieAttributes ? { defaultCookieAttributes: deps.cookieAttributes } : {}),
    },
    ...(trustedOrigins.length ? { trustedOrigins: [...new Set(trustedOrigins)] } : {}),
    hooks: authHooks(deps),
    databaseHooks: databaseHooks(deps),
    emailAndPassword: methods.emailPassword
      ? {
          enabled: true,
          password: { hash: hashPassword, verify: verifyPassword },
          disableSignUp: !signup.allowNewUsers,
          requireEmailVerification: signup.requireEmailVerification,
          autoSignIn: signup.autoSignInAfterVerify,
          minPasswordLength: signup.minPasswordLength,
          maxPasswordLength: signup.maxPasswordLength,
          revokeSessionsOnPasswordReset: sessions.revokeOnPasswordReset,
        }
      : { enabled: false },
    ...(verifiesEmail ? { emailVerification: emailVerification(deps, signup.autoSignInAfterVerify) } : {}),
    // Better Auth uses one persistent session token rather than a distinct app
    // refresh token. expiresIn controls both its DB expiry and cookie max-age;
    // Better Auth keeps its standard sliding refresh cadence (`updateAge`).
    session: {
      ...sessionConfig,
      // Read-only on the session Better Auth returns, set by the after-hook.
      additionalFields: { aal: { type: 'string', required: false, input: false } },
    },
    user: {
      deleteUser: { enabled: true },
      additionalFields: USER_ADDITIONAL_FIELDS,
    },
    socialProviders: buildSocialProviders(deps),
    plugins: buildPlugins(deps, methods),
  });

  // Every HTTP entry into this instance goes through `handler` (it is what
  // toNodeHandler mounts), so this is where a request gets its start time: the
  // access token it may mint is dated from before anything was read
  // (auth/access-tokens.ts).
  const handle = auth.handler;
  auth.handler = request => datingAccessTokens(() => handle(request));
  return auth;
}

export type AuthInstance = ReturnType<typeof createProjectAuth>;
