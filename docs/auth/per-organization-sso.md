# Per-organization SSO

Your project ships with Better Auth's `organization` and `sso` plugins so that
each end-user **organization** (a customer company / team inside your app) can
bring its **own** identity provider (Okta, Google Workspace, Entra ID, a SAML
IdP, any OIDC issuer) and its members sign in through it. This is tenant data,
managed at runtime by the org's own admins; it is **not** project configuration
in the console.

## The mental model

There are two different things to configure:

- **Auth · Organizations** controls the Better Auth organization plugin: organization creation, teams, and member limits.
- **Auth · SSO (OIDC / SAML)** is the only switch that controls SSO. It also controls per-organization SSO.

An organization's identity provider is not entered in either project setting. It is tenant data: an org admin registers it at runtime, and the record carries that organization's `organizationId`.

## 1. Turn it on (console → Authentication → Organizations)

1. Enable **Auth · SSO** (`auth.sso`). **This is the only switch that governs
   SSO**, per-organization SSO included: it mounts the plugin and its
   `/api/auth/sso/*` endpoints. There is no second, organization-level SSO
   toggle, and nothing in **Auth · Organizations** can enable or disable SSO.
2. In **Auth · Organizations** (`auth.organization`), leave the plugin enabled so
   users have organizations to attach providers to. Configure teams and the
   member limit there; those options do not turn SSO on or off.

> The setting formerly labelled **"Orgs can register their own SSO"**
> (`allowOrgSso`) never affected SSO. Its only effect was to turn on Better
> Auth's organization *teams*, so it has been renamed **"Teams inside
> organizations"** (`teamsEnabled`). Installs that had it on keep their teams.
> The old key is still read.

Saving applies live: the server rebuilds the auth instance, no restart. The
`ssoProvider` and `team` tables were created by the `auth_plugin_tables`
migration.

## 2. An org admin registers their IdP (runtime, via the client SDK)

Registration is scoped to an `organizationId`, so only that org's members are
routed to that IdP.

```ts
import { createClient } from '@motherbase/client';

const client = createClient('https://<your-project-domain>', '<publishable-key>');

// OIDC via discovery: an owner or admin of the organization runs this while signed in.
const { data, error } = await client.auth.sso.register({
  providerId: 'bigcorp-okta',
  issuer: 'https://bigcorp.okta.com',
  domain: 'bigcorp.com',                // email domain that maps to this provider
  organizationId: '<org-id>',
  oidcConfig: {
    clientId: '<client-id>',
    clientSecret: '<client-secret>',
    // Better Auth fetches the authorization, token and JWKS endpoints from here:
    discoveryEndpoint: 'https://bigcorp.okta.com/.well-known/openid-configuration',
    scopes: ['openid', 'email', 'profile'],
  },
});
// data.redirectURI is the callback URL to configure at the IdP.
```

SAML is registered the same way with a `samlConfig` block instead of `oidcConfig`.

**Callback URL** to configure at the IdP:
`https://<your-project-domain>/api/auth/sso/callback/<providerId>`.

## 3. Members sign in through their org's IdP

```ts
// By email domain (the provider is resolved from the domain)…
await client.auth.signIn.sso({ email: 'jane@bigcorp.com', callbackURL: '/dashboard' });

// …or explicitly by provider id / organization slug:
await client.auth.signIn.sso({ providerId: 'bigcorp-okta', callbackURL: '/dashboard' });
```

On success the user is provisioned (per Better Auth's SSO settings) and added to
the matching organization: subject to **Maximum members per organization**
(`auth.organization.maxMembers`, 0 = unlimited), which also caps direct member
adds and invitation accepts. A sign-in that would exceed the cap is refused with
a message naming the limit rather than silently creating an extra seat. Manage members, roles, teams and invitations with
`client.auth.organization.*`, and the registered providers with
`client.auth.sso.providers / getProvider / updateProvider / deleteProvider`.

## Notes

- Provider records live in the `ssoProvider` table keyed by `providerId`
  (unique) and carry an optional `organizationId`. This is what makes SSO
  per-organization rather than global.
- The console (motherbase operator) login is deliberately **not** affected by any
  of this: it stays email + password only. See
  `tests/console-auth-instance.unit.test.ts`.
- Project-wide providers (a single Google/GitHub button for everyone) are a
  different feature: configure those under **Auth · Social providers**
  (`auth.social`) or **Auth · Custom OIDC** (`auth.oauth.custom`).
