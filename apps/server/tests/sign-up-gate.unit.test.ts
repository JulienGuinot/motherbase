import { describe, it, expect, vi } from 'vitest';
import { evaluateSignUp, parseDomains, signPayload, type SignUpGateConfig } from '../auth/hooks/sign-up-gate';

const hookDeps = (request: any) => ({ outboundHttpClient: { request } });

const OFF: SignUpGateConfig = {
  enabled: false,
  emailDomainMode: 'off',
  emailDomains: '',
  webhookUrl: '',
  webhookSecret: '',
};
const noFetch = hookDeps((() => {
  throw new Error('fetch should not be called');
}) as any);

describe('sign-up gate', () => {
  it('parseDomains splits on commas/whitespace and lowercases', () => {
    expect(parseDomains('Acme.com, corp.io\n foo.dev')).toEqual(['acme.com', 'corp.io', 'foo.dev']);
    expect(parseDomains('')).toEqual([]);
  });

  it('allows everything when disabled', async () => {
    expect(await evaluateSignUp(OFF, { email: 'x@nope.com' }, noFetch)).toEqual({ allow: true });
  });

  it('allow-list: denies domains not on the list, permits those on it', async () => {
    const cfg: SignUpGateConfig = { ...OFF, enabled: true, emailDomainMode: 'allow', emailDomains: 'acme.com' };
    expect((await evaluateSignUp(cfg, { email: 'a@acme.com' }, noFetch)).allow).toBe(true);
    const denied = await evaluateSignUp(cfg, { email: 'a@evil.com' }, noFetch);
    expect(denied.allow).toBe(false);
    expect(denied.reason).toMatch(/allow list/i);
  });

  it('block-list: denies domains on the list', async () => {
    const cfg: SignUpGateConfig = { ...OFF, enabled: true, emailDomainMode: 'block', emailDomains: 'evil.com' };
    expect((await evaluateSignUp(cfg, { email: 'a@evil.com' }, noFetch)).allow).toBe(false);
    expect((await evaluateSignUp(cfg, { email: 'a@ok.com' }, noFetch)).allow).toBe(true);
  });

  it('webhook: honours an allow verdict and signs the body when a secret is set', async () => {
    const cfg: SignUpGateConfig = { ...OFF, enabled: true, webhookUrl: 'https://h/hook', webhookSecret: 'sk' };
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      // signature present + correct
      const body = init.body as string;
      expect(init.headers['X-Signature']).toBe(signPayload(body, 'sk'));
      return new Response(JSON.stringify({ allow: true }), { status: 200 });
    });
    const res = await evaluateSignUp(cfg, { email: 'a@x.com' }, hookDeps(fetchMock));
    expect(res.allow).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('webhook: honours a deny verdict with its reason', async () => {
    const cfg: SignUpGateConfig = { ...OFF, enabled: true, webhookUrl: 'https://h/hook', webhookSecret: '' };
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ allow: false, reason: 'blocklisted' }), { status: 200 })
    );
    const res = await evaluateSignUp(cfg, { email: 'a@x.com' }, hookDeps(fetchMock));
    expect(res).toEqual({ allow: false, reason: 'blocklisted' });
  });

  it('webhook: fails CLOSED on non-2xx, invalid body, and network error', async () => {
    const cfg: SignUpGateConfig = { ...OFF, enabled: true, webhookUrl: 'https://h/hook', webhookSecret: '' };
    const non2xx = await evaluateSignUp(
      cfg,
      { email: 'a@x.com' },
      hookDeps((async () => new Response('nope', { status: 500 })) as any)
    );
    expect(non2xx.allow).toBe(false);
    const invalid = await evaluateSignUp(
      cfg,
      { email: 'a@x.com' },
      hookDeps((async () => new Response('{}', { status: 200 })) as any)
    );
    expect(invalid.allow).toBe(false);
    const boom = await evaluateSignUp(
      cfg,
      { email: 'a@x.com' },
      hookDeps((async () => {
        throw new Error('down');
      }) as any)
    );
    expect(boom.allow).toBe(false);
  });

  it('applies the domain rule before the webhook (denies without calling out)', async () => {
    const cfg: SignUpGateConfig = {
      ...OFF,
      enabled: true,
      emailDomainMode: 'allow',
      emailDomains: 'acme.com',
      webhookUrl: 'https://h/hook',
    };
    const res = await evaluateSignUp(cfg, { email: 'a@evil.com' }, noFetch);
    expect(res.allow).toBe(false);
  });
});
