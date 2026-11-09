import { z } from 'zod';
import type { GroupDef } from './types';
import { DEFAULT_AUTH_RATE_LIMITS } from '../../auth/rate-limit-defaults';
import { THIRD_PARTY_TYPES } from '../../auth/third-party';
import { CAPTCHA_AUTH_ENDPOINTS, captchaRoutesSchema } from '../../lib/captcha-routes';

const socialEntry = z
  .object({
    enabled: z.coerce.boolean().default(false),
    clientId: z.string().optional().default(''),
    clientSecret: z.string().optional().default(''),
    audiences: z.string().optional().default(''), // apple: id-token aud
    clientIds: z.string().optional().default(''), // google: id-token aud list
  })
  .partial();

// One JSON group holding every social provider so adding a provider needs no new
// group. clientSecret of each entry is encrypted at rest and masked on read.
// Keys are the provider ids better-auth ships: google, apple, github, discord,
// microsoft, facebook, twitter, twitch, gitlab, spotify, linkedin, dropbox,
// reddit, kick, roblox, vk, tiktok, zoom.
export const authSocial: GroupDef = {
  key: 'auth.social',
  label: 'Auth · Social providers',
  fields: [
    {
      key: 'providers',
      label: 'Providers (JSON)',
      type: 'json',
      secretKeys: ['clientSecret'],
      placeholder: '{ "github": { "enabled": true, "clientId": "...", "clientSecret": "..." } }',
    },
  ],
  schema: z.object({ providers: z.record(z.string(), socialEntry).default({}) }),
  envFallback: () => ({
    providers: {
      google: {
        enabled: !!process.env.GOOGLE_CLIENT_ID,
        clientId: process.env.GOOGLE_CLIENT_ID || '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
        clientIds: process.env.GOOGLE_CLIENT_ID || '',
      },
      apple: {
        enabled: !!process.env.APPLE_CLIENT_ID,
        clientId: process.env.APPLE_CLIENT_ID || '',
        clientSecret: process.env.APPLE_CLIENT_SECRET || '',
        audiences: process.env.APPLE_BUNDLE_ID || '',
      },
    },
  }),
};

// Fully custom OIDC/OAuth2 providers (the genericOAuth escape hatch).
const genericProvider = z.object({
  providerId: z.string().min(1, 'providerId is required'),
  clientId: z.string().min(1, 'clientId is required'),
  clientSecret: z.string().optional().default(''),
  discoveryUrl: z.string().optional().default(''),
  authorizationUrl: z.string().optional().default(''),
  tokenUrl: z.string().optional().default(''),
  userInfoUrl: z.string().optional().default(''),
  scopes: z.array(z.string()).optional().default([]),
});

export const authOauthCustom: GroupDef = {
  key: 'auth.oauth.custom',
  label: 'Auth · Custom OIDC',
  fields: [
    {
      key: 'providers',
      label: 'Custom OIDC providers (JSON array)',
      type: 'json',
      secretKeys: ['clientSecret'],
      placeholder: '[ { "providerId": "acme", "clientId": "...", "clientSecret": "...", "discoveryUrl": "..." } ]',
    },
  ],
  schema: z.object({ providers: z.array(genericProvider).default([]) }),
  envFallback: () => ({ providers: [] }),
};

export const authMethods: GroupDef = {
  key: 'auth.methods',
  label: 'Auth · Methods',
  fields: [
    { key: 'emailPassword', label: 'Email + password', type: 'bool', default: true },
    { key: 'magicLink', label: 'Magic link', type: 'bool', default: true },
    { key: 'emailOTP', label: 'Email OTP', type: 'bool', default: true },
    // Supabase's "Allow anonymous sign-ins". Off by default there too: a guest
    // account is a real row, so an open endpoint is a way to fill the table.
    { key: 'anonymous', label: 'Anonymous sign-ins', type: 'bool', default: false,
      help: 'signInAnonymously() creates a guest user with is_anonymous = true, upgraded in place when it links an email or a provider.' },
  ],
  schema: z.object({
    emailPassword: z.coerce.boolean().default(true),
    magicLink: z.coerce.boolean().default(true),
    emailOTP: z.coerce.boolean().default(true),
    anonymous: z.coerce.boolean().default(false),
  }),
  envFallback: () => ({ emailPassword: true, magicLink: true, emailOTP: true, anonymous: false }),
};

export const authSignup: GroupDef = {
  key: 'auth.signup',
  label: 'Auth · Sign-up & passwords',
  description: 'Registration and password policy. Applies to new sign-ups and sign-ins after saving.',
  fields: [
    { key: 'allowNewUsers', label: 'Allow new sign-ups', type: 'bool', default: true,
      help: 'Turn off to close registration. Existing users can still sign in.' },
    { key: 'requireEmailVerification', label: 'Require email verification', type: 'bool', default: false,
      help: 'Block sign-in until the email address is verified.' },
    { key: 'autoSignInAfterVerify', label: 'Auto sign-in after sign-up', type: 'bool', default: true },
    { key: 'minPasswordLength', label: 'Minimum password length', type: 'number', default: 8 },
    { key: 'maxPasswordLength', label: 'Maximum password length', type: 'number', default: 128 },
  ],
  schema: z.object({
    allowNewUsers: z.coerce.boolean().default(true),
    requireEmailVerification: z.coerce.boolean().default(false),
    autoSignInAfterVerify: z.coerce.boolean().default(true),
    minPasswordLength: z.coerce.number().int().min(1).max(1024).default(8),
    maxPasswordLength: z.coerce.number().int().min(1).max(1024).default(128),
  }).refine(v => v.minPasswordLength <= v.maxPasswordLength, {
    message: 'minPasswordLength must be ≤ maxPasswordLength',
    path: ['minPasswordLength'],
  }),
  envFallback: () => ({
    allowNewUsers: process.env.AUTH_ALLOW_SIGNUP !== 'false',
    requireEmailVerification: process.env.AUTH_REQUIRE_EMAIL_VERIFICATION === 'true',
    autoSignInAfterVerify: process.env.AUTH_AUTO_SIGNIN !== 'false',
    minPasswordLength: Number(process.env.AUTH_MIN_PASSWORD_LENGTH) || 8,
    maxPasswordLength: Number(process.env.AUTH_MAX_PASSWORD_LENGTH) || 128,
  }),
};

// Session behaviour. The overall session length lives in auth.tokens (Token
// expiry); this controls refresh cadence, the freshness window for sensitive
// actions, and revocation on password reset. Applied live via AuthManager.
export const authSessions: GroupDef = {
  key: 'auth.sessions',
  label: 'Auth · Sessions',
  description: 'Session refresh, freshness, and revocation. Overall session length is set in Token expiry.',
  fields: [
    { key: 'revokeOnPasswordReset', label: 'Revoke all sessions on password reset', type: 'bool', default: true,
      help: 'Sign every other device out when a user resets their password.' },
    { key: 'disableRefresh', label: 'Disable sliding refresh', type: 'bool', default: false,
      help: 'When on, sessions expire at a fixed time instead of extending on use.' },
    { key: 'updateAgeHours', label: 'Refresh cadence (hours)', type: 'number', default: 24,
      help: 'How often an active session is extended. Ignored when sliding refresh is disabled.' },
    { key: 'freshAgeMinutes', label: 'Fresh window (minutes)', type: 'number', default: 0,
      help: 'How long after sign-in a session counts as "fresh" for sensitive actions. 0 disables the freshness requirement.' },
  ],
  schema: z.object({
    revokeOnPasswordReset: z.coerce.boolean().default(true),
    disableRefresh: z.coerce.boolean().default(false),
    updateAgeHours: z.coerce.number().int().min(0).max(24 * 3650).default(24),
    freshAgeMinutes: z.coerce.number().int().min(0).max(60 * 24 * 3650).default(0),
  }),
  envFallback: () => ({ revokeOnPasswordReset: true, disableRefresh: false, updateAgeHours: 24, freshAgeMinutes: 0 }),
};

export const authTwoFactor: GroupDef = {
  key: 'auth.twoFactor',
  label: 'Auth · Two-factor',
  fields: [
    { key: 'enabled', label: 'Enabled', type: 'bool', default: false },
    { key: 'issuer', label: 'Issuer (shown in authenticator apps)', type: 'text', placeholder: 'MyApp' },
    { key: 'totpDigits', label: 'TOTP digits (6 or 8)', type: 'number', default: 6 },
    { key: 'totpPeriod', label: 'TOTP period (seconds)', type: 'number', default: 30 },
    { key: 'otpChannel', label: 'OTP second factor channel', type: 'select', default: 'off',
      options: [{ value: 'off', label: 'Off' }, { value: 'email', label: 'Email' }, { value: 'sms', label: 'SMS' }] },
    { key: 'otpDigits', label: 'OTP digits', type: 'number', default: 6 },
    { key: 'otpPeriodMinutes', label: 'OTP validity (minutes)', type: 'number', default: 3 },
    { key: 'backupCodeCount', label: 'Backup codes count', type: 'number', default: 10 },
    { key: 'backupCodeLength', label: 'Backup code length', type: 'number', default: 10 },
    { key: 'trustDeviceDays', label: 'Trust device for (days)', type: 'number', default: 30 },
  ],
  schema: z.object({
    enabled: z.coerce.boolean().default(false),
    issuer: z.string().optional().default(''),
    totpDigits: z.coerce.number().int().refine(n => n === 6 || n === 8, 'digits must be 6 or 8').default(6),
    totpPeriod: z.coerce.number().int().positive().default(30),
    otpChannel: z.enum(['off', 'email', 'sms']).default('off'),
    otpDigits: z.coerce.number().int().min(4).max(10).default(6),
    otpPeriodMinutes: z.coerce.number().int().positive().default(3),
    backupCodeCount: z.coerce.number().int().min(1).max(50).default(10),
    backupCodeLength: z.coerce.number().int().min(6).max(32).default(10),
    trustDeviceDays: z.coerce.number().int().min(0).default(30),
  }),
  envFallback: () => ({
    enabled: false,
    issuer: '',
    totpDigits: 6,
    totpPeriod: 30,
    otpChannel: 'off',
    otpDigits: 6,
    otpPeriodMinutes: 3,
    backupCodeCount: 10,
    backupCodeLength: 10,
    trustDeviceDays: 30,
  }),
};

export const authPasskey: GroupDef = {
  key: 'auth.passkey',
  label: 'Auth · Passkey',
  fields: [
    { key: 'enabled', label: 'Enabled', type: 'bool', default: false },
    { key: 'rpId', label: 'Relying-party ID (domain)', type: 'text', placeholder: 'myapp.io' },
    { key: 'rpName', label: 'Relying-party name', type: 'text' },
    { key: 'origin', label: 'Origin', type: 'text', placeholder: 'https://myapp.io' },
  ],
  schema: z.object({
    enabled: z.coerce.boolean().default(false),
    rpId: z.string().optional().default(''),
    rpName: z.string().optional().default(''),
    origin: z.string().optional().default(''),
  }),
  envFallback: () => ({ enabled: false, rpId: '', rpName: '', origin: '' }),
};

// Auth-side phone OTP behaviour. The SMS transport (Twilio creds) lives in the
// shared `phone.sms` group so SP3 MFA and notifications reuse one sender.
export const authPhoneOtp: GroupDef = {
  key: 'auth.phoneOtp',
  label: 'Auth · Phone (SMS)',
  fields: [
    { key: 'enabled', label: 'Enable phone sign-in', type: 'bool', default: false },
    { key: 'otpLength', label: 'OTP length', type: 'number', default: 6 },
    { key: 'expiresIn', label: 'OTP expiry (seconds)', type: 'number', default: 300 },
    { key: 'signUpOnVerification', label: 'Create account on first verified number', type: 'bool', default: true },
  ],
  schema: z.object({
    enabled: z.coerce.boolean().default(false),
    otpLength: z.coerce.number().int().min(4).max(10).default(6),
    expiresIn: z.coerce.number().int().positive().default(300),
    signUpOnVerification: z.coerce.boolean().default(true),
  }),
  envFallback: () => ({
    enabled: false,
    otpLength: 6,
    expiresIn: 300,
    signUpOnVerification: true,
  }),
};

// Supabase-style "before user created" gate. See auth/hooks/sign-up-gate.ts.
export const authHooksSignUp: GroupDef = {
  key: 'auth.hooks.signUp',
  label: 'Auth · Sign-up gate',
  fields: [
    { key: 'enabled', label: 'Enabled', type: 'bool', default: false },
    { key: 'emailDomainMode', label: 'Email domain rule', type: 'select', default: 'off',
      options: [{ value: 'off', label: 'Off' }, { value: 'allow', label: 'Allow-list' }, { value: 'block', label: 'Block-list' }] },
    { key: 'emailDomains', label: 'Email domains (comma separated)', type: 'text', placeholder: 'acme.com, corp.io' },
    { key: 'webhookUrl', label: 'Verdict webhook URL', type: 'text', placeholder: 'https://…/hooks/signup' },
    { key: 'webhookSecret', label: 'Webhook signing secret', type: 'password', secret: true },
  ],
  schema: z.object({
    enabled: z.coerce.boolean().default(false),
    emailDomainMode: z.enum(['off', 'allow', 'block']).default('off'),
    emailDomains: z.string().optional().default(''),
    webhookUrl: z.string().optional().default(''),
    webhookSecret: z.string().optional().default(''),
  }),
  envFallback: () => ({ enabled: false, emailDomainMode: 'off', emailDomains: '', webhookUrl: '', webhookSecret: '' }),
};

// Supabase-style "custom access token" hook. See auth/hooks/access-token.ts.
export const authHooksAccessToken: GroupDef = {
  key: 'auth.hooks.accessToken',
  label: 'Auth · Access token claims',
  fields: [
    { key: 'enabled', label: 'Enabled', type: 'bool', default: false },
    { key: 'includeUserFields', label: 'User fields to include (comma separated)', type: 'text', placeholder: 'role, status, username' },
    { key: 'staticClaims', label: 'Static claims (JSON)', type: 'json' },
  ],
  schema: z.object({
    enabled: z.coerce.boolean().default(false),
    includeUserFields: z.string().optional().default(''),
    staticClaims: z.record(z.string(), z.any()).optional().default({}),
  }),
  envFallback: () => ({ enabled: false, includeUserFields: '', staticClaims: {} }),
};

// Supabase-style "send email / send SMS" override hooks. See auth/hooks/send-hook.ts.
export const authHooksSend: GroupDef = {
  key: 'auth.hooks.send',
  label: 'Auth · Delivery override',
  fields: [
    { key: 'enabled', label: 'Enabled', type: 'bool', default: false },
    { key: 'email', label: 'Override email delivery', type: 'bool', default: false },
    { key: 'sms', label: 'Override SMS delivery', type: 'bool', default: false },
    { key: 'webhookUrl', label: 'Delivery webhook URL', type: 'text', placeholder: 'https://…/hooks/send' },
    { key: 'webhookSecret', label: 'Webhook signing secret', type: 'password', secret: true },
  ],
  schema: z.object({
    enabled: z.coerce.boolean().default(false),
    email: z.coerce.boolean().default(false),
    sms: z.coerce.boolean().default(false),
    webhookUrl: z.string().optional().default(''),
    webhookSecret: z.string().optional().default(''),
  }),
  envFallback: () => ({ enabled: false, email: false, sms: false, webhookUrl: '', webhookSecret: '' }),
};

// Supabase-style auth-event webhook (audit / notify). See auth/hooks/event-hook.ts.
export const authHooksEvents: GroupDef = {
  key: 'auth.hooks.events',
  label: 'Auth · Event webhook',
  fields: [
    { key: 'enabled', label: 'Enabled', type: 'bool', default: false },
    { key: 'events', label: 'Events (comma separated path fragments)', type: 'text', placeholder: 'sign-in, sign-up, sign-out' },
    { key: 'webhookUrl', label: 'Event webhook URL', type: 'text', placeholder: 'https://…/hooks/auth-events' },
    { key: 'webhookSecret', label: 'Webhook signing secret', type: 'password', secret: true },
  ],
  schema: z.object({
    enabled: z.coerce.boolean().default(false),
    events: z.string().optional().default(''),
    webhookUrl: z.string().optional().default(''),
    webhookSecret: z.string().optional().default(''),
  }),
  envFallback: () => ({ enabled: false, events: '', webhookUrl: '', webhookSecret: '' }),
};

// Supabase's URL Configuration. Enforced on every redirect an auth flow ends
// in (auth/redirect-urls.ts): a redirect not allowed here falls back to the
// Site URL, as in GoTrue. Both empty = not enforced, Better Auth's own
// trusted-origin check (the CORS allowlist) is then the only one.
const redirectEntry = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9+.-]*:\/\/\S+$/i, 'Each redirect URL needs a scheme, e.g. https://app.example.com/**');

export const authUrls: GroupDef = {
  key: 'auth.urls',
  label: 'Auth · URL configuration',
  description: 'The Site URL and the redirect URLs auth flows may send users back to. Wildcards: * (within a segment), ** (anything), ? (one character).',
  fields: [
    { key: 'siteUrl', label: 'Site URL', type: 'text', placeholder: 'https://app.example.com',
      help: 'The default redirect when none is given or the one given is not allowed.' },
    { key: 'redirectUrls', label: 'Redirect URLs (comma separated)', type: 'text', multiline: true,
      placeholder: 'http://localhost:3000/**, https://*-acme.vercel.app/**' },
  ],
  schema: z.object({
    siteUrl: z.union([z.literal(''), z.string().trim().url('Site URL must be an absolute URL')]).default(''),
    redirectUrls: z
      .string()
      .default('')
      .refine(raw => parseRedirectList(raw).every(entry => redirectEntry.safeParse(entry).success), {
        message: 'Each redirect URL needs a scheme, e.g. https://app.example.com/**',
      }),
  }),
  envFallback: () => ({ siteUrl: process.env.AUTH_SITE_URL || '', redirectUrls: process.env.AUTH_REDIRECT_URLS || '' }),
};

/** Split the stored comma / newline list into entries. */
export function parseRedirectList(raw: string | undefined): string[] {
  return (raw ?? '').split(/[\s,]+/).map(entry => entry.trim()).filter(Boolean);
}

// Supabase's Third-Party Auth: issuers whose JWTs the data API accepts.
// Verified per request by auth/third-party.ts against each issuer's JWKS.
const thirdPartyProvider = z.object({
  id: z.string().min(1, 'id is required').max(64),
  type: z.enum(THIRD_PARTY_TYPES),
  enabled: z.coerce.boolean().default(true),
  issuer: z.string().url('issuer must be an absolute URL'),
  jwksUrl: z.union([z.literal(''), z.string().url('jwksUrl must be an absolute URL')]).optional().default(''),
  audience: z.string().optional().default(''),
});

export const authThirdParty: GroupDef = {
  key: 'auth.thirdParty',
  label: 'Auth · Third-party auth',
  description:
    'JWTs from Clerk, Firebase Auth, Auth0, AWS Cognito or WorkOS, accepted by the data API. The role claim picks the Postgres role (anon, else authenticated; service_role is refused).',
  fields: [
    { key: 'providers', label: 'Providers (JSON array)', type: 'json',
      placeholder: '[ { "id": "clerk", "type": "clerk", "issuer": "https://clerk.example.com" } ]' },
  ],
  schema: z.object({ providers: z.array(thirdPartyProvider).default([]) }).refine(
    v => new Set(v.providers.map(p => p.issuer)).size === v.providers.length,
    { message: 'Two providers cannot share an issuer', path: ['providers'] },
  ),
  envFallback: () => ({ providers: [] }),
};

// Supabase's Auth · Rate Limits, enforced by auth/rate-limits.ts. Separate
// from security.rateLimit's single `auth` bucket, which still applies on top.
const perWindow = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback);

export const authRateLimits: GroupDef = {
  key: 'auth.rateLimits',
  label: 'Auth · Rate limits',
  description: 'Per-kind auth limits with GoTrue\'s windows. Counted per IP, except email and SMS, which are per project.',
  fields: [
    { key: 'emailSentPerHour', label: 'Emails sent per hour', type: 'number', default: DEFAULT_AUTH_RATE_LIMITS.emailSentPerHour,
      help: 'Every auth email (sign-up confirmation, magic link, OTP, recovery), across the whole project.' },
    { key: 'smsSentPerHour', label: 'SMS sent per hour', type: 'number', default: DEFAULT_AUTH_RATE_LIMITS.smsSentPerHour,
      help: 'Every auth text message, across the whole project.' },
    { key: 'tokenRefreshPer5Min', label: 'Token refreshes per 5 minutes', type: 'number', default: DEFAULT_AUTH_RATE_LIMITS.tokenRefreshPer5Min,
      help: 'Access tokens minted (/token) per IP.' },
    { key: 'verifyPer5Min', label: 'Verifications per 5 minutes', type: 'number', default: DEFAULT_AUTH_RATE_LIMITS.verifyPer5Min,
      help: 'OTP, magic-link, email, MFA and PKCE verifications per IP.' },
    { key: 'signInSignUpPer5Min', label: 'Sign-ups and sign-ins per 5 minutes', type: 'number', default: DEFAULT_AUTH_RATE_LIMITS.signInSignUpPer5Min,
      help: 'Per IP, all methods together.' },
    { key: 'anonymousPerHour', label: 'Anonymous sign-ins per hour', type: 'number', default: DEFAULT_AUTH_RATE_LIMITS.anonymousPerHour,
      help: 'Per IP.' },
  ],
  schema: z.object({
    emailSentPerHour: perWindow(100_000, DEFAULT_AUTH_RATE_LIMITS.emailSentPerHour),
    smsSentPerHour: perWindow(100_000, DEFAULT_AUTH_RATE_LIMITS.smsSentPerHour),
    tokenRefreshPer5Min: perWindow(100_000, DEFAULT_AUTH_RATE_LIMITS.tokenRefreshPer5Min),
    verifyPer5Min: perWindow(100_000, DEFAULT_AUTH_RATE_LIMITS.verifyPer5Min),
    signInSignUpPer5Min: perWindow(100_000, DEFAULT_AUTH_RATE_LIMITS.signInSignUpPer5Min),
    anonymousPerHour: perWindow(100_000, DEFAULT_AUTH_RATE_LIMITS.anonymousPerHour),
  }),
  envFallback: () => ({ ...DEFAULT_AUTH_RATE_LIMITS }),
};

// Supabase's Auth · Attack Protection, plus what Supabase does not offer: CAPTCHA
// on any route, including the REST API of tables a project created. On auth
// endpoints it is Better Auth's captcha plugin; on `captchaRoutes` it is
// middlewares/captcha-guard.ts. Both read the token from the same header with
// the same provider, see lib/captcha-routes.ts. Leaked-password protection is
// the haveibeenpwned plugin, a k-anonymity range query, so only a 5-character
// hash prefix leaves the server.
export const authAttackProtection: GroupDef = {
  key: 'auth.attackProtection',
  label: 'Auth · Attack protection',
  description: 'CAPTCHA on the auth endpoints and on any other route you choose, and a leaked-password check.',
  fields: [
    { key: 'captchaEnabled', label: 'Enable CAPTCHA protection', type: 'bool', default: false,
      help: 'Clients must then send a token in the x-captcha-response header on every guarded call, '
        + 'auth calls included (fetchOptions.headers with client.auth).' },
    { key: 'captchaProvider', label: 'CAPTCHA provider', type: 'select', default: 'hcaptcha',
      options: [{ value: 'hcaptcha', label: 'hCaptcha' }, { value: 'turnstile', label: 'Cloudflare Turnstile' }] },
    { key: 'captchaSecret', label: 'CAPTCHA secret', type: 'password', secret: true },
    { key: 'captchaSiteKey', label: 'Site key (hCaptcha, optional)', type: 'text',
      help: 'When set, hCaptcha also checks the token was issued for this site key.' },
    { key: 'captchaAuthEndpoints', label: 'Guarded auth endpoints', type: 'json', default: [...CAPTCHA_AUTH_ENDPOINTS],
      help: `Which auth calls need a token. Any of ${CAPTCHA_AUTH_ENDPOINTS.join(', ')}. All of them by default, as in Supabase.` },
    { key: 'captchaRoutes', label: 'Other guarded routes', type: 'json', default: [],
      placeholder: '[ { "methods": ["POST"], "pathGlob": "/rest/v1/orders" } ]',
      help: 'Any other route: a table\'s REST API (/rest/v1/<table>), an edge function (/api/edge/<name>), storage. '
        + '* matches any run of characters. No methods means every method. Server-side callers must send a token too.' },
    { key: 'leakedPasswordProtection', label: 'Prevent use of leaked passwords', type: 'bool', default: false,
      help: 'Rejects passwords found in HaveIBeenPwned. Only the first 5 characters of the SHA-1 hash are sent.' },
  ],
  schema: z.object({
    captchaEnabled: z.coerce.boolean().default(false),
    captchaProvider: z.enum(['hcaptcha', 'turnstile']).default('hcaptcha'),
    captchaSecret: z.string().optional().default(''),
    captchaSiteKey: z.string().optional().default(''),
    captchaAuthEndpoints: z.array(z.enum(CAPTCHA_AUTH_ENDPOINTS)).default([...CAPTCHA_AUTH_ENDPOINTS]),
    captchaRoutes: captchaRoutesSchema.default([]),
    leakedPasswordProtection: z.coerce.boolean().default(false),
  }).refine(v => !v.captchaEnabled || !!v.captchaSecret, {
    message: 'A CAPTCHA secret is required to enable CAPTCHA protection',
    path: ['captchaSecret'],
  }),
  envFallback: () => ({
    captchaEnabled: false,
    captchaProvider: 'hcaptcha',
    captchaSecret: '',
    captchaSiteKey: '',
    captchaAuthEndpoints: [...CAPTCHA_AUTH_ENDPOINTS],
    captchaRoutes: [],
    leakedPasswordProtection: false,
  }),
};

export const authApiKey: GroupDef = {
  key: 'auth.apiKey',
  label: 'Auth · User API keys',
  description: 'Personal API keys each user mints through the auth API. Not the project keys (api.keys).',
  fields: [{ key: 'enabled', label: 'Enabled', type: 'bool', default: false }],
  schema: z.object({ enabled: z.coerce.boolean().default(false) }),
  envFallback: () => ({ enabled: false }),
};

export const authSso: GroupDef = {
  key: 'auth.sso',
  label: 'Auth · SSO (OIDC / SAML)',
  description:
    'The single switch for OIDC / SAML SSO, including per-organization SSO. When on, it mounts the SSO ' +
    'plugin and its /api/auth/sso/* endpoints. When off, no provider can be registered or used. The ' +
    'provider a user reaches is tenant data in ssoProvider records, not an organization setting here.',
  fields: [
    { key: 'enabled', label: 'Enabled', type: 'bool', default: false,
      help: 'Required for all SSO, including per-organization SSO. Auth · Organizations has no SSO switch of its own.' },
  ],
  schema: z.object({ enabled: z.coerce.boolean().default(false) }),
  envFallback: () => ({ enabled: false }),
};

export const authOrganization: GroupDef = {
  key: 'auth.organization',
  label: 'Auth · Organizations',
  description:
    'End-user organizations (Better Auth organization plugin): creation, teams, and member limits. SSO ' +
    'is not configured here. Enable it in Auth · SSO, the only switch that governs SSO.',
  fields: [
    { key: 'enabled', label: 'Enabled', type: 'bool', default: true },
    { key: 'allowUserToCreateOrganization', label: 'Users can create orgs', type: 'bool', default: true },
    // Renamed from `allowOrgSso`, which never had anything to do with SSO: its
    // only effect was `teams: { enabled: true }` on the organization plugin.
    // auth-manager still reads the old stored key so no install changes behaviour.
    { key: 'teamsEnabled', label: 'Teams inside organizations', type: 'bool', default: false,
      help: 'Adds Better Auth team sub-groups and their endpoints. This is unrelated to SSO; org admins register identity providers at runtime.' },
    { key: 'maxMembers', label: 'Maximum members per organization', type: 'number', default: 0,
      help: '0 = unlimited. Applies when a member is added directly, when an invitation is accepted, and when SSO auto-provisions a member.' },
  ],
  schema: z.object({
    enabled: z.coerce.boolean().default(true),
    allowUserToCreateOrganization: z.coerce.boolean().default(true),
    teamsEnabled: z.coerce.boolean().default(false),
    maxMembers: z.coerce.number().int().min(0).max(1_000_000).default(0),
  }),
  envFallback: () => ({
    enabled: true,
    allowUserToCreateOrganization: true,
    teamsEnabled: false,
    maxMembers: 0,
  }),
};



export const AUTH_TOKEN_EXPIRY_LIMITS = {
  accessTokenExpMin: { min: 1, max: 7 * 24 * 60 },
  sessionExpDays: { min: 1, max: 3650 },
} as const;

// JWT / Better Auth session expiry. The legacy `refreshTokenExpDays` key is
// retained for stored-setting compatibility; Better Auth has one persistent
// session token, so this value maps to session + session-cookie lifetime.
export const authTokens: GroupDef = {
  key: 'auth.tokens',
  label: 'Auth · Token expiry',
  fields: [
    {
      key: 'accessTokenExpMin',
      label: 'Access token lifetime (minutes)',
      type: 'number',
      default: 15,
      placeholder: '15',
    },
    {
      key: 'refreshTokenExpDays',
      label: 'Session lifetime (days)',
      type: 'number',
      default: 30,
      placeholder: '30',
    },
  ],
  schema: z.object({
    accessTokenExpMin: z.coerce
      .number()
      .int()
      .min(AUTH_TOKEN_EXPIRY_LIMITS.accessTokenExpMin.min)
      .max(AUTH_TOKEN_EXPIRY_LIMITS.accessTokenExpMin.max)
      .default(15),
    refreshTokenExpDays: z.coerce
      .number()
      .int()
      .min(AUTH_TOKEN_EXPIRY_LIMITS.sessionExpDays.min)
      .max(AUTH_TOKEN_EXPIRY_LIMITS.sessionExpDays.max)
      .default(30),
  }),
  envFallback: () => ({
    accessTokenExpMin: Number(process.env.ACCESS_TOKEN_EXP_MIN) || 15,
    refreshTokenExpDays: Number(process.env.REFRESH_TOKEN_EXP_DAYS) || 30,
  }),
};

// Scheduled automatic database backups. Changing these from the console
// reschedules the in-process backup job live (no restart). Env seeds defaults.
