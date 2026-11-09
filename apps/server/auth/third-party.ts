import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

// Supabase's Third-Party Auth: JWTs issued by Clerk, Firebase Auth, Auth0,
// AWS Cognito or WorkOS are accepted as callers of the data API (REST,
// storage), verified against the issuer's JWKS.
//
// The token's `role` claim picks the Postgres role, as Supabase documents:
// `anon` runs as anon, absent or `authenticated` as authenticated, and
// `service_role` is refused outright (a third party must never mint a key that
// bypasses RLS). Every claim reaches policies through `auth.jwt()`, and `sub`
// through `auth.uid()`, so `auth.jwt()->>'org_id'` works the way it does there.
//
// These callers have no row in auth.users: they are identities of another
// system, which is why only the data plane accepts them.

export const THIRD_PARTY_TYPES = ['clerk', 'firebase', 'auth0', 'cognito', 'workos', 'custom'] as const;
export type ThirdPartyType = (typeof THIRD_PARTY_TYPES)[number];

export interface ThirdPartyProvider {
  id: string;
  type: ThirdPartyType;
  enabled: boolean;
  /** Exact `iss` claim. */
  issuer: string;
  /** Empty = the issuer's well-known location (see defaultJwksUrl). */
  jwksUrl?: string;
  /** Required `aud`, when set (Firebase: the project id). */
  audience?: string;
}

export interface ThirdPartyCaller {
  sub: string;
  email: string | null;
  role: 'anon' | 'authenticated';
  claims: JWTPayload;
  providerId: string;
}

/** Firebase publishes its keys away from its issuer; every other provider here at the OIDC default. */
export function defaultJwksUrl(provider: Pick<ThirdPartyProvider, 'type' | 'issuer'>): string {
  if (provider.type === 'firebase') {
    return 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
  }
  return `${provider.issuer.replace(/\/+$/, '')}/.well-known/jwks.json`;
}

/** Cheap pre-check, so an opaque Better Auth session token never costs a JWT parse. */
export function looksLikeJwt(token: string): boolean {
  return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token);
}

/** Asymmetric algorithms only: a JWKS publishes public keys, so an HMAC alg can never be legitimate here. */
const ASYMMETRIC_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

export type JwksResolver = (url: string) => JWTVerifyGetKey;

/**
 * One key set per JWKS URL, kept for the process: jose caches the keys and
 * refetches on an unknown `kid`, which is how a provider's key rotation lands.
 */
export function remoteJwks(): JwksResolver {
  const sets = new Map<string, JWTVerifyGetKey>();
  return url => {
    let set = sets.get(url);
    if (!set) {
      set = createRemoteJWKSet(new URL(url));
      sets.set(url, set);
    }
    return set;
  };
}

/**
 * The caller behind a third-party token, or null when the token belongs to no
 * enabled provider. Throws when it claims a configured issuer but does not
 * verify: a forged or expired token must be a 401, not a silent anon.
 */
export async function verifyThirdPartyToken(
  token: string,
  providers: ThirdPartyProvider[],
  jwks: JwksResolver,
): Promise<ThirdPartyCaller | null> {
  if (!looksLikeJwt(token)) return null;
  let issuer: string | undefined;
  try {
    issuer = decodeJwt(token).iss;
  } catch {
    return null;
  }
  const provider = providers.find(p => p.enabled && p.issuer && p.issuer === issuer);
  if (!provider) return null;

  const { payload } = await jwtVerify(token, jwks(provider.jwksUrl || defaultJwksUrl(provider)), {
    issuer: provider.issuer,
    algorithms: ASYMMETRIC_ALGORITHMS,
    ...(provider.audience ? { audience: provider.audience } : {}),
  });
  if (!payload.sub) throw new Error('Third-party token has no sub claim');
  if (payload.role === 'service_role') throw new Error('Third-party tokens cannot carry the service_role role');
  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    role: payload.role === 'anon' ? 'anon' : 'authenticated',
    claims: payload,
    providerId: provider.id,
  };
}
