import { describe, it, expect } from 'vitest';
import { readAccessTokenFromUrl } from '../src/auth/utils.js';

/**
 * The provider callback is a browser redirect, so it cannot answer the SDK with
 * a JSON body. The backend appends `#access_token=…` to the redirect it issues
 * and `getSessionFromUrl()` turns that into a stored session (see
 * auth-session-sync.test.ts).
 */
describe('readAccessTokenFromUrl', () => {
  it('reads the token and removes it from the URL', () => {
    const found = readAccessTokenFromUrl('https://app.dev/cb#access_token=tok&token_type=bearer');
    expect(found).toEqual({ accessToken: 'tok', cleanedHref: 'https://app.dev/cb' });
  });

  it('keeps a fragment the app was already using', () => {
    const found = readAccessTokenFromUrl('https://app.dev/cb#tab=profile&access_token=tok');
    expect(found?.accessToken).toBe('tok');
    expect(found?.cleanedHref).toBe('https://app.dev/cb#tab=profile');
  });

  it('returns null when there is nothing to read', () => {
    expect(readAccessTokenFromUrl('https://app.dev/cb')).toBeNull();
    expect(readAccessTokenFromUrl('https://app.dev/cb#other=1')).toBeNull();
    expect(readAccessTokenFromUrl('https://app.dev/cb?error=state_mismatch')).toBeNull();
  });
});
