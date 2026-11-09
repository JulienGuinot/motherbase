import { afterEach, describe, expect, it, vi } from 'vitest';
import { captchaRoutesSchema, matchesCaptchaRoute, verifyCaptchaToken } from '../lib/captcha-routes';
import { applyCaptchaConfig, captchaGuard } from '../middlewares/captcha-guard';

describe('matchesCaptchaRoute', () => {
  const routes = captchaRoutesSchema.parse([
    { methods: ['POST'], pathGlob: '/rest/v1/orders' },
    { pathGlob: '/api/edge/*' },
  ]);

  it('guards the REST API of a table the project created, on the methods chosen', () => {
    expect(matchesCaptchaRoute(routes, 'POST', '/rest/v1/orders')).toBe(true);
    expect(matchesCaptchaRoute(routes, 'GET', '/rest/v1/orders')).toBe(false);
    expect(matchesCaptchaRoute(routes, 'POST', '/rest/v1/orders_archive')).toBe(false);
  });

  it('guards every method when none is named, except a preflight', () => {
    expect(matchesCaptchaRoute(routes, 'GET', '/api/edge/chat')).toBe(true);
    expect(matchesCaptchaRoute(routes, 'OPTIONS', '/api/edge/chat')).toBe(false);
  });

  it('refuses a path that does not start with /', () => {
    expect(captchaRoutesSchema.safeParse([{ pathGlob: 'rest/v1/orders' }]).success).toBe(false);
  });
});

describe('verifyCaptchaToken', () => {
  const verifier = { provider: 'hcaptcha' as const, secretKey: 's3cret', siteKey: 'site' };
  const reply = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as Response);

  it('sends what the provider expects and reads its verdict', async () => {
    const fetchImpl = reply({ success: true });
    await expect(verifyCaptchaToken(verifier, 'tok', '1.2.3.4', fetchImpl)).resolves.toBe('verified');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.hcaptcha.com/siteverify');
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      secret: 's3cret', response: 'tok', remoteip: '1.2.3.4', sitekey: 'site',
    });
  });

  it('tells a rejected token from a provider that is down', async () => {
    await expect(verifyCaptchaToken(verifier, 'tok', undefined, reply({ success: false }))).resolves.toBe('rejected');
    await expect(verifyCaptchaToken(verifier, 'tok', undefined, reply({}, false))).resolves.toBe('unavailable');
    const throwing = vi.fn(async () => { throw new Error('offline'); });
    await expect(verifyCaptchaToken(verifier, 'tok', undefined, throwing)).resolves.toBe('unavailable');
  });
});

describe('captchaGuard', () => {
  afterEach(() => applyCaptchaConfig(null));

  function run(req: { method: string; path: string; token?: string }) {
    const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json: vi.fn() };
    const next = vi.fn();
    const request: any = { ...req, ip: '1.2.3.4', get: (name: string) => (name === 'x-captcha-response' ? req.token : undefined) };
    return Promise.resolve(captchaGuard(request, res, next)).then(() => ({ res, next }));
  }

  const config = {
    captchaEnabled: true,
    captchaProvider: 'hcaptcha' as const,
    captchaSecret: 's3cret',
    captchaRoutes: [{ methods: ['POST'], pathGlob: '/rest/v1/*' }, { pathGlob: '/api/auth/*' }],
  };

  it('refuses a guarded call that carries no token with Better Auth\'s 400', async () => {
    applyCaptchaConfig(config);
    const { res, next } = await run({ method: 'POST', path: '/rest/v1/orders' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 0, code: 'MISSING_RESPONSE' }));
  });

  it('leaves unguarded routes, and auth calls the plugin owns, alone', async () => {
    applyCaptchaConfig(config);
    expect((await run({ method: 'GET', path: '/rest/v1/orders' })).next).toHaveBeenCalled();
    // Even when a rule names it: verifying here would spend the plugin's single-use token.
    expect((await run({ method: 'POST', path: '/api/auth/sign-up/email' })).next).toHaveBeenCalled();
  });

  it('is a no-op while CAPTCHA is off, whatever the routes say', async () => {
    applyCaptchaConfig({ ...config, captchaEnabled: false });
    expect((await run({ method: 'POST', path: '/rest/v1/orders' })).next).toHaveBeenCalled();
  });
});
