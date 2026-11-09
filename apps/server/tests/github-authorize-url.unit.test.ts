import { describe, expect, it } from 'vitest';
import { OAUTH_SCOPES, authorizeUrl } from '../services/admin/git/github-api';

describe('GitHub authorizeUrl', () => {
  it('encodes state and callback so they round-trip intact', () => {
    const callback = 'https://api.example.com/admin/git/callback?x=1&y=a b';
    const state = 'a+b/c=d&e';
    const url = new URL(authorizeUrl('client-1', callback, state));

    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe(callback);
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('scope')).toBe(OAUTH_SCOPES);
    expect(url.searchParams.get('allow_signup')).toBe('false');
    // A raw `&` in the state must not leak out as a separate parameter.
    expect([...url.searchParams.keys()].sort()).toEqual(['allow_signup', 'client_id', 'redirect_uri', 'scope', 'state']);
  });
});
