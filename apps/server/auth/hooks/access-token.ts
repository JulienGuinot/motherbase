// Supabase-style "custom access token" hook. Lets a project add claims to the
// JWT it issues, driven by console config: copy selected user fields into the
// token and/or merge a fixed set of static claims. Pure and synchronous so it is
// trivially testable and adds no latency to token minting.

export interface AccessTokenConfig {
  enabled: boolean;
  /** User fields copied verbatim into the token (e.g. role, status, username). */
  includeUserFields: string[];
  /** Fixed claims merged into every token. */
  staticClaims: Record<string, unknown>;
}

// Never let a hook leak security-sensitive or reserved fields into a JWT.
const BLOCKED_FIELDS = new Set(['password', 'passwordHash', 'twoFactorEnabled', 'phoneNumberVerified']);
const RESERVED_CLAIMS = new Set(['iss', 'sub', 'aud', 'exp', 'nbf', 'iat', 'jti']);

export function buildClaims(
  config: AccessTokenConfig | undefined,
  user: Record<string, unknown>,
): Record<string, unknown> {
  if (!config?.enabled) return {};
  const claims: Record<string, unknown> = {};

  for (const field of config.includeUserFields ?? []) {
    const key = field.trim();
    if (!key || BLOCKED_FIELDS.has(key)) continue;
    if (user[key] !== undefined) claims[key] = user[key];
  }

  for (const [key, value] of Object.entries(config.staticClaims ?? {})) {
    if (RESERVED_CLAIMS.has(key)) continue; // never override standard JWT claims
    claims[key] = value;
  }

  return claims;
}

/** Parse the comma/space separated field list from the settings text field. */
export function parseFieldList(raw: string): string[] {
  return (raw || '')
    .split(/[\s,]+/)
    .map(f => f.trim())
    .filter(Boolean);
}
