import { describe, it, expect } from 'vitest';
import {
  compileRedirectPattern,
  enforceRedirects,
  isAllowedRedirect,
  redirectOrigins,
  resolveRedirect,
  type RedirectConfig,
} from '../auth/redirect-urls';

const config: RedirectConfig = {
  siteUrl: 'https://app.example.com',
  allowList: ['http://localhost:3000/**', 'https://*-acme.vercel.app/**', 'myapp://auth/callback'],
};

describe('compileRedirectPattern (GoTrue globs)', () => {
  it('stops * at dots and slashes, lets ** cross them', () => {
    expect(compileRedirectPattern('https://*.example.com').test('https://a.example.com')).toBe(true);
    expect(compileRedirectPattern('https://*.example.com').test('https://a.b.example.com')).toBe(false);
    expect(compileRedirectPattern('http://localhost:3000/**').test('http://localhost:3000/a/b?c=1')).toBe(true);
    expect(compileRedirectPattern('http://localhost:300?/cb').test('http://localhost:3001/cb')).toBe(true);
  });

  it('treats regex metacharacters literally', () => {
    expect(compileRedirectPattern('https://a.com/x+y').test('https://a.com/x+y')).toBe(true);
    expect(compileRedirectPattern('https://a.com').test('https://aXcom')).toBe(false);
  });
});

describe('isAllowedRedirect', () => {
  it.each([
    ['https://app.example.com', true],
    ['https://app.example.com/welcome?x=1', true],
    ['http://localhost:3000/auth/callback', true],
    ['https://pr-12-acme.vercel.app/cb', true],
    ['myapp://auth/callback', true],
    ['/dashboard', true],
    ['https://app.example.com.evil.com/', false],
    ['https://evil.com/?next=https://app.example.com', false],
    ['//evil.com', false],
    ['javascript:alert(1)', false],
    ['http://localhost:4000/', false],
  ])('%s -> %s', (url, allowed) => {
    expect(isAllowedRedirect(url, config)).toBe(allowed);
  });

  it('keeps a Site URL with a path to that path', () => {
    const scoped = { siteUrl: 'https://example.com/app', allowList: [] };
    expect(isAllowedRedirect('https://example.com/app/cb', scoped)).toBe(true);
    expect(isAllowedRedirect('https://example.com/application', scoped)).toBe(false);
  });

  it('ignores the PKCE parameters the SDK appends', () => {
    const exact = { siteUrl: '', allowList: ['https://app.test/cb'] };
    expect(isAllowedRedirect('https://app.test/cb?code_challenge=abc&code_challenge_method=s256', exact)).toBe(true);
  });
});

describe('resolveRedirect', () => {
  it('falls back to the Site URL, as GoTrue does', () => {
    expect(resolveRedirect('https://evil.com', config)).toBe('https://app.example.com');
    expect(resolveRedirect(undefined, config)).toBe('https://app.example.com');
    expect(resolveRedirect('http://localhost:3000/x', config)).toBe('http://localhost:3000/x');
  });
});

describe('redirectOrigins', () => {
  it('derives trusted origins, keeping host wildcards and dropping custom schemes', () => {
    expect(redirectOrigins(config)).toEqual([
      'https://app.example.com',
      'http://localhost:3000',
      'https://*-acme.vercel.app',
    ]);
  });
});

describe('enforceRedirects', () => {
  it('rewrites only the disallowed redirect fields', () => {
    expect(
      enforceRedirects({ provider: 'github', callbackURL: 'https://evil.com', errorCallbackURL: '/error' }, config),
    ).toEqual({ provider: 'github', callbackURL: 'https://app.example.com', errorCallbackURL: '/error' });
  });

  it('returns null when everything is already allowed', () => {
    expect(enforceRedirects({ callbackURL: 'http://localhost:3000/cb' }, config)).toBeNull();
  });

  it('defaults a missing callback to the Site URL where asked', () => {
    expect(enforceRedirects({ provider: 'github' }, config, { defaultCallback: true })).toMatchObject({
      callbackURL: 'https://app.example.com',
    });
    expect(enforceRedirects({ provider: 'github' }, config)).toBeNull();
  });
});

describe('enforceRedirects with PKCE', () => {
  it('moves the challenge onto the Site URL it falls back to', () => {
    const patched = enforceRedirects({ callbackURL: 'https://evil.com/?code_challenge=abc&code_challenge_method=s256' }, config);
    expect(patched?.callbackURL).toBe('https://app.example.com/?code_challenge=abc&code_challenge_method=s256');
  });
});
