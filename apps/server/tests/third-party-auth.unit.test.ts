import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  defaultJwksUrl,
  looksLikeJwt,
  verifyThirdPartyToken,
  type ThirdPartyProvider,
} from '../auth/third-party';

const provider: ThirdPartyProvider = {
  id: 'test',
  type: 'custom',
  enabled: true,
  issuer: 'https://issuer.example.test',
  audience: 'motherbase',
};

async function signedToken(claims: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(provider.issuer)
    .setAudience(provider.audience!)
    .setSubject('external-user')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  return { token, jwk };
}

describe('third-party auth', () => {
  it('recognizes JWTs and derives the provider JWKS URL', () => {
    expect(looksLikeJwt('header.payload.signature')).toBe(true);
    expect(looksLikeJwt('opaque-session-token')).toBe(false);
    expect(defaultJwksUrl(provider)).toBe(`${provider.issuer}/.well-known/jwks.json`);
    expect(defaultJwksUrl({ ...provider, type: 'firebase' })).toContain('securetoken@system.gserviceaccount.com');
  });

  it('returns null for a valid JWT from an unconfigured issuer', async () => {
    const { token, jwk } = await signedToken();
    const caller = await verifyThirdPartyToken(token, [], () => async () => jwk);
    expect(caller).toBeNull();
  });

  it('verifies the issuer and audience and maps the role safely', async () => {
    const { token, jwk } = await signedToken({ email: 'user@example.test', role: 'anon', org_id: 'org-1' });
    const caller = await verifyThirdPartyToken(token, [provider], () => async () => jwk);
    expect(caller).toMatchObject({
      sub: 'external-user',
      email: 'user@example.test',
      role: 'anon',
      providerId: 'test',
      claims: { org_id: 'org-1' },
    });
  });

  it('rejects service_role and invalid audience claims', async () => {
    const service = await signedToken({ role: 'service_role' });
    await expect(verifyThirdPartyToken(service.token, [provider], () => async () => service.jwk))
      .rejects.toThrow('service_role');

    const wrongAudience = await signedToken();
    const mismatched = { ...provider, audience: 'another-project' };
    await expect(verifyThirdPartyToken(wrongAudience.token, [mismatched], () => async () => wrongAudience.jwk))
      .rejects.toThrow();
  });
});
