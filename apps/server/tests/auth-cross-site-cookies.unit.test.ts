import { describe, it, expect } from 'vitest';
import { crossSiteCookieAttributes } from '../auth/auth-origins';

const NONE = { sameSite: 'none', secure: true };

describe('crossSiteCookieAttributes', () => {
  it('keeps the Lax default when every trusted origin is the same site', () => {
    expect(crossSiteCookieAttributes('https://api.example.com', ['https://api.example.com'])).toBeUndefined();
    // A sibling subdomain is same-site, so Lax still stores and sends the cookie.
    expect(crossSiteCookieAttributes('https://api.example.com', ['https://app.example.com'])).toBeUndefined();
  });

  it('relaxes SameSite when a frontend on another site is trusted', () => {
    expect(crossSiteCookieAttributes('https://api.example.com', ['https://app.other.dev'])).toEqual(NONE);
    // The exact shape that produced ?error=state_mismatch: API on a project
    // subdomain, app served from somewhere else entirely.
    expect(
      crossSiteCookieAttributes('https://acme.example.test', ['http://localhost:3000']),
    ).toEqual(NONE);
  });

  it('treats an allow-all list as cross-site', () => {
    expect(crossSiteCookieAttributes('https://api.example.com', ['*'])).toEqual(NONE);
  });

  it('never relaxes over plain http: a browser drops SameSite=None without Secure', () => {
    expect(crossSiteCookieAttributes('http://api.localhost', ['*'])).toBeUndefined();
    expect(crossSiteCookieAttributes('http://api.example.com', ['https://app.other.dev'])).toBeUndefined();
  });

  it('ignores a malformed entry rather than throwing', () => {
    expect(crossSiteCookieAttributes('https://api.example.com', ['not a url'])).toBeUndefined();
  });
});
