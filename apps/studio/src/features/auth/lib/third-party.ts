// Third-Party Auth providers as the server stores them (auth.thirdParty). The
// pure part of the editor lives here: what a new row looks like, and the
// problems the server's schema would reject a row for.

export const THIRD_PARTY_TYPES = [
  { value: 'clerk', label: 'Clerk', issuerHint: 'https://your-app.clerk.accounts.dev' },
  { value: 'firebase', label: 'Firebase Auth', issuerHint: 'https://securetoken.google.com/<project-id>' },
  { value: 'auth0', label: 'Auth0', issuerHint: 'https://your-tenant.auth0.com/' },
  { value: 'cognito', label: 'AWS Cognito', issuerHint: 'https://cognito-idp.<region>.amazonaws.com/<pool-id>' },
  { value: 'workos', label: 'WorkOS', issuerHint: 'https://api.workos.com/user_management/<client-id>' },
  { value: 'custom', label: 'Custom OIDC', issuerHint: 'https://issuer.example.com' },
] as const;

export type ThirdPartyType = (typeof THIRD_PARTY_TYPES)[number]['value'];

export interface ThirdPartyProvider {
  id: string;
  type: ThirdPartyType;
  enabled: boolean;
  issuer: string;
  jwksUrl: string;
  audience: string;
}

/** A blank row whose id does not collide with the existing ones. */
export function newProvider(existing: readonly ThirdPartyProvider[], type: ThirdPartyType = 'clerk'): ThirdPartyProvider {
  const taken = new Set(existing.map(p => p.id));
  let n = existing.length + 1;
  while (taken.has(`${type}-${n}`)) n++;
  return { id: `${type}-${n}`, type, enabled: true, issuer: '', jwksUrl: '', audience: '' };
}

const isUrl = (value: string) => /^https?:\/\/\S+$/i.test(value);

/** One message per problem, keyed by row index, mirroring the server schema. */
export function providerProblems(providers: readonly ThirdPartyProvider[]): Map<number, string> {
  const problems = new Map<number, string>();
  providers.forEach((p, i) => {
    if (!p.id.trim()) problems.set(i, 'An id is required.');
    else if (providers.findIndex(o => o.id === p.id) !== i) problems.set(i, 'Ids must be unique.');
    else if (!isUrl(p.issuer)) problems.set(i, 'The issuer must be an absolute URL.');
    else if (p.jwksUrl && !isUrl(p.jwksUrl)) problems.set(i, 'The JWKS URL must be an absolute URL.');
    else if (providers.findIndex(o => o.issuer === p.issuer) !== i) problems.set(i, 'Two providers cannot share an issuer.');
  });
  return problems;
}
