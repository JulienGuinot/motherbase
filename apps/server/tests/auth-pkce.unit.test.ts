import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createPkceCodec, pkceChallengeOf, verifierMatches, PKCE_CODE_TTL_MS } from '../auth/pkce';
import { attachOAuthTokenToRedirect, withAuthCode } from '../auth/oauth-redirect';

const verifier = 'v'.repeat(50);
const challenge = createHash('sha256').update(verifier).digest('base64url');

describe('PKCE codec', () => {
  it('seals and opens a session token with its challenge', () => {
    const codec = createPkceCodec('secret');
    const code = codec.mint('tok.sig', challenge, 's256');
    expect(code).not.toContain('tok');
    expect(codec.open(code)).toEqual({ token: 'tok.sig', challenge, method: 's256' });
  });

  it('refuses a code sealed with another secret, tampered with, or expired', () => {
    let now = 1_000;
    const codec = createPkceCodec('secret', () => now);
    const code = codec.mint('tok', challenge, 's256');
    expect(createPkceCodec('other').open(code)).toBeNull();
    expect(codec.open(`${code.slice(0, -2)}AA`)).toBeNull();
    now += PKCE_CODE_TTL_MS + 1;
    expect(codec.open(code)).toBeNull();
  });

  it('checks the verifier against an S256 or plain challenge', () => {
    expect(verifierMatches(verifier, challenge, 's256')).toBe(true);
    expect(verifierMatches('w'.repeat(50), challenge, 's256')).toBe(false);
    expect(verifierMatches(verifier, verifier, 'plain')).toBe(true);
  });

  it('reads the challenge off a redirect, absolute or relative', () => {
    expect(pkceChallengeOf('https://app.test/cb?code_challenge=abc')).toEqual({ challenge: 'abc', method: 's256' });
    expect(pkceChallengeOf('/cb?code_challenge=abc&code_challenge_method=plain')).toEqual({ challenge: 'abc', method: 'plain' });
    expect(pkceChallengeOf('https://app.test/cb')).toBeNull();
  });
});

describe('PKCE redirect', () => {
  it('replaces the challenge with ?code= and keeps everything else', () => {
    expect(withAuthCode('myapp://cb?x=1&code_challenge=c&code_challenge_method=s256#frag', 'CODE')).toBe('myapp://cb?x=1&code=CODE#frag');
  });

  it('hands a PKCE callback a code instead of the token', () => {
    const headers: Record<string, unknown> = {
      location: 'https://app.test/cb?code_challenge=' + challenge,
      'set-cookie': ['better-auth.session_token=tok.sig; Path=/; HttpOnly'],
    };
    const res = {
      writeHead: () => undefined,
      getHeader: (name: string) => headers[name] as string,
      setHeader: (name: string, value: string) => { headers[name] = value; },
    };
    const codec = createPkceCodec('secret');
    attachOAuthTokenToRedirect(res, 'better-auth.session_token', codec);
    res.writeHead();
    const location = new URL(String(headers.location));
    expect(location.hash).toBe('');
    expect(location.searchParams.has('code_challenge')).toBe(false);
    expect(codec.open(location.searchParams.get('code')!)?.token).toBe('tok.sig');
  });
});
