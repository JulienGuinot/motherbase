import { AsyncLocalStorage } from 'node:async_hooks';
import { APIError } from 'better-auth/api';
import BaseContext from '../context/base-context';
import { env } from '../config/env';
import { parseRedirectList } from '../config/settings/auth.groups';
import { parseCorsOrigins } from '../middlewares/cors.middleware';
import { createProjectAuth, type AuthInstance, type GenericOAuthConfig, type ProjectAuthDeps } from './instance';
import { evaluateSignUp, type SignUpGateConfig } from './hooks/sign-up-gate';
import type { SendHookConfig, AuthMessage } from './hooks/send-hook';
import { emitEvent, matchesEvent, type EventHookConfig } from './hooks/event-hook';
import { auditEventFor, auditNeedsActorId } from './audit-actions';
import { redirectOrigins, type RedirectConfig } from './redirect-urls';
import { DEFAULT_AUTH_RATE_LIMITS, DeliveryQuota, type AuthRateLimits } from './rate-limits';
import { authStatus, type AuthStatusItem } from './auth-status';
import { logAuthActivity } from './auth-activity';
import { crossSiteCookieAttributes, resolveBaseUrl } from './auth-origins';
import { AuthDelivery } from './auth-delivery';
import { canDeliver, deliveryChannel, deliveryNotConfigured, type DeliveryRoutes } from './delivery-preflight';
import {
  accessTokenClaims,
  captchaOptions,
  enabledSocialProviders,
  eventHookConfig,
  organizationOptions,
  passkeyOptions,
  phoneSignIn,
  sessionOptions,
  signupOptions,
  twoFactorOptions,
  twoFactorOtpChannel,
  usableGenericOAuth,
} from './auth-options';

// Builds the project Better Auth instance from the auth.* settings groups and
// caches it. reload() drops the cache so the next current() rebuilds. Used when
// auth config changes from the console (no redeploy). Construction opens no DB
// connection, so rebuilds are cheap and in-flight requests keep their handler.

export class AuthManager extends BaseContext {
  private cached: AuthInstance | null = null;
  private building: Promise<AuthInstance> | null = null;
  /** Set while captureMessages() runs: outbound auth mail lands here instead of being sent. */
  private readonly capture = new AsyncLocalStorage<AuthMessage[]>();
  /** auth.rateLimits as of the last build; read by the per-IP limiter in app.ts. */
  private limits: AuthRateLimits = DEFAULT_AUTH_RATE_LIMITS;
  private readonly quota = new DeliveryQuota();

  /** The live Auth · Rate limits (rebuilt with the instance on a settings save). */
  async rateLimits(): Promise<AuthRateLimits> {
    await this.current();
    return this.limits;
  }

  /** Spend one message of the hourly project quota, or refuse the request with 429. */
  private spendDeliveryQuota(channel: 'email' | 'sms'): void {
    if (this.quota.allow(channel, this.limits)) return;
    throw new APIError('TOO_MANY_REQUESTS', {
      code: channel === 'email' ? 'over_email_send_rate_limit' : 'over_sms_send_rate_limit',
      message: `${channel === 'email' ? 'Email' : 'SMS'} rate limit exceeded`,
    });
  }

  /**
   * Run `fn` with every auth email and SMS it triggers captured instead of
   * delivered. This is how `auth.admin.generateLink` gets the link Better Auth
   * would have mailed: the flow runs exactly as it does for a user, only the
   * last step changes hands. Scoped to `fn`'s async context, so a concurrent
   * sign-in on the same instance still gets its email.
   */
  async captureMessages<T>(fn: () => Promise<T>): Promise<{ result: T; messages: AuthMessage[] }> {
    const messages: AuthMessage[] = [];
    const result = await this.capture.run(messages, fn);
    return { result, messages };
  }

  /**
   * Refuse, before Better Auth runs it, a request that would send an email or
   * SMS this project cannot deliver. Read from settings per request, so a
   * transport configured in Studio counts at once.
   */
  private async assertDeliverable(
    path: string,
    body: Record<string, unknown> | undefined,
    routes: DeliveryRoutes & { testNumbers: Record<string, string> },
  ): Promise<void> {
    const channel = deliveryChannel(path, routes);
    if (!channel) return;
    // generateLink captures the message instead of sending it.
    if (this.capture.getStore()) return;
    // A test number gets its fixed code without any SMS.
    if (channel === 'sms' && typeof body?.phoneNumber === 'string' && routes.testNumbers[body.phoneNumber]) return;
    const s = this.di.SettingsService;
    const deliverable = canDeliver(channel, {
      smtp: await s.get('email.smtp'),
      sms: await s.get('phone.sms'),
      sendHook: await s.get('auth.hooks.send'),
    });
    if (!deliverable) throw deliveryNotConfigured(channel);
  }

  /** True when the message was captured, i.e. must not be delivered. */
  private captured(message: AuthMessage): boolean {
    const sink = this.capture.getStore();
    if (!sink) return false;
    sink.push(message);
    return true;
  }

  async current(): Promise<AuthInstance> {
    if (this.cached) return this.cached;
    if (!this.building) {
      this.building = this.build().then(a => {
        this.cached = a;
        this.building = null;
        return a;
      });
    }
    return this.building;
  }

  reload(): void {
    this.cached = null;
    this.building = null;
  }

  private baseURL(): string {
    return resolveBaseUrl(env.BASE_HOST, env.IS_PRODUCTION);
  }

  /**
   * better-auth runs its own CSRF origin check (separate from CORS). Trust the
   * same allowlist the CORS layer uses so browser clients on other origins
   * (e.g. the web app) are not rejected with 403 INVALID_ORIGIN. baseURL stays
   * trusted implicitly. '*' → trust all.
   *
   * In dev, match CORS semantics: an empty allowlist means "allow all" (see
   * resolveCorsOrigin). In production it must not, validateProdCorsConfig()
   * only checks the CORS_ORIGINS env var at boot, while this `server.cors`
   * setting is editable from Studio at runtime. Clearing it there would
   * otherwise silently turn off better-auth's CSRF origin check for every auth
   * endpoint. Fall back to our own origin, which is always legitimate.
   */
  private async trustedOrigins(): Promise<string[]> {
    const cors = await this.di.SettingsService.get<{ origins: string }>('server.cors');
    const corsOrigins = parseCorsOrigins(cors?.origins ?? env.CORS_ORIGINS);
    const trustAll = !corsOrigins.length || corsOrigins.includes('*');
    if (!trustAll) return corsOrigins;
    return env.IS_PRODUCTION ? [this.baseURL()] : ['*'];
  }

  private async redirects(): Promise<RedirectConfig> {
    const urls = await this.di.SettingsService.get<{ siteUrl?: string; redirectUrls?: string }>('auth.urls');
    return { siteUrl: urls?.siteUrl ?? '', allowList: parseRedirectList(urls?.redirectUrls) };
  }

  /**
   * Always set: this is also how auth activity reaches the Logs stream. The
   * request logger only sees `POST /api/auth/sign-in/email → 200`, which does
   * not say who signed in, or whether a 200 was a sign-in or a 2FA challenge.
   */
  private authRequestListener(eventHook: EventHookConfig | undefined): NonNullable<ProjectAuthDeps['onAuthRequest']> {
    return ({ path, userId, email, ip, error }) => {
      logAuthActivity(path, userId, error);
      // Supabase's auth.audit_log_entries records what happened, so only
      // successes, and a session event only once it is known whose it is.
      const audit = error ? null : auditEventFor(path);
      if (audit && (userId || (email && !auditNeedsActorId(audit)))) {
        this.di.AuthAuditService.recordInBackground({ event: audit, actorId: userId, actorUsername: email, ipAddress: ip });
      }
      // Also feeds the general-purpose Webhooks page, which can trigger on
      // `auth.sign-in` etc. alongside table row events. Separate from the
      // dedicated single-URL auth event webhook below.
      void this.di.EventDispatcherService.dispatchAuth(path, userId).catch(() => {});
      if (!eventHook || !matchesEvent(eventHook, path)) return;
      // Fire-and-forget: do not await, swallow errors.
      void emitEvent(
        eventHook,
        { type: path.replace(/^\//, ''), path, userId, at: new Date().toISOString() },
        { outboundHttpClient: this.di.OutboundHttpClient },
      ).catch(() => {});
    };
  }

  private async build(): Promise<AuthInstance> {
    const s = this.di.SettingsService;
    this.limits = { ...DEFAULT_AUTH_RATE_LIMITS, ...(await s.get<Partial<AuthRateLimits>>('auth.rateLimits')) };
    const baseURL = this.baseURL();
    const trustedOrigins = await this.trustedOrigins();
    const redirects = await this.redirects();
    const twoFactor = await s.get<any>('auth.twoFactor');
    const attack = await s.get<any>('auth.attackProtection');
    const phone = phoneSignIn(await s.get('auth.phoneOtp'), await s.get('phone.sms'));
    const otpChannel = twoFactorOtpChannel(twoFactor, phone.smsReady);
    const signUpGate = await s.get<SignUpGateConfig>('auth.hooks.signUp');
    const signUpSendsEmail =
      (await s.get<{ emailPassword?: boolean }>('auth.methods'))?.emailPassword !== false &&
      !!(await s.get<{ requireEmailVerification?: boolean }>('auth.signup'))?.requireEmailVerification;
    const delivery = new AuthDelivery(this.di, {
      sendHook: await s.get<SendHookConfig>('auth.hooks.send'),
      spendQuota: channel => this.spendDeliveryQuota(channel),
      captured: message => this.captured(message),
    });

    return createProjectAuth({
      prisma: this.di.prisma,
      secret: env.JWT_SECRET,
      baseURL,
      trustedOrigins,
      redirects,
      // The Site URL and the redirect allowlist are frontends too: one on
      // another site needs the same SameSite=None cookies a CORS origin does.
      cookieAttributes: crossSiteCookieAttributes(baseURL, [...trustedOrigins, ...redirectOrigins(redirects)]),
      socialProviders: enabledSocialProviders((await s.get<{ providers: Record<string, any> }>('auth.social')).providers),
      genericOAuth: usableGenericOAuth((await s.get<{ providers: GenericOAuthConfig[] }>('auth.oauth.custom')).providers),
      methods: await s.get('auth.methods'),
      signup: signupOptions(await s.get('auth.signup')),
      sessions: sessionOptions(await s.get('auth.sessions')),
      tokens: await s.get('auth.tokens'),
      twoFactor: twoFactorOptions(twoFactor),
      sendTwoFactorOtp: otpChannel && delivery.twoFactorOtp(otpChannel),
      captcha: captchaOptions(attack),
      leakedPasswordProtection: !!attack?.leakedPasswordProtection,
      passkey: passkeyOptions(await s.get('auth.passkey')),
      apiKey: !!(await s.get<{ enabled: boolean }>('auth.apiKey'))?.enabled,
      sso: !!(await s.get<{ enabled: boolean }>('auth.sso'))?.enabled,
      phoneOtp: phone.options,
      sendSms: phone.options && delivery.smsOtp,
      organization: organizationOptions(await s.get('auth.organization')),
      sendOtp: delivery.emailOtp,
      sendReauthenticationNonce: delivery.reauthenticationNonce,
      assertDeliverable: (path, body) =>
        this.assertDeliverable(path, body, {
          twoFactorChannel: otpChannel,
          signUpSendsEmail,
          testNumbers: phone.options?.testNumbers ?? {},
        }),
      sendMagicLink: delivery.magicLink,
      sendVerificationLink: delivery.verificationLink,
      beforeUserCreated: signUpGate?.enabled
        ? user => evaluateSignUp(signUpGate, user, { outboundHttpClient: this.di.OutboundHttpClient })
        : undefined,
      // Better Auth owns user creation for every method (email/password, social,
      // magic link, OTP, passkey…), and it does not populate `username`. Without
      // this every account would land with a null username.
      generateUsername: async () => (await this.di.UserService.getRandomUsername()).data.username,
      accessTokenClaims: accessTokenClaims(await s.get('auth.hooks.accessToken')),
      onAuthRequest: this.authRequestListener(eventHookConfig(await s.get('auth.hooks.events'))),
    });
  }

  /** Per provider/plugin readiness: enabled? configured? what is missing? callback URL. */
  status(): Promise<AuthStatusItem[]> {
    return authStatus(this.di.SettingsService, this.baseURL());
  }
}
