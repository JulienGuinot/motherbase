# Security policy

Motherbase runs databases, storage and authentication for other people's
projects. Vulnerabilities here are serious and we would rather hear about them
from you than from an incident.

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub Security
Advisories:

[Report a vulnerability](https://github.com/JulienGuinot/motherbase/security/advisories/new)

Please include:

- what the vulnerability lets an attacker do
- affected component (API server, Platform Console, Studio, CLI, SDK, deploy
  scripts) and the version or commit
- reproduction steps, and a proof of concept where you have one
- how the instance is deployed, if it matters (`setup.sh`, plain Compose,
  development checkout)

You will get an acknowledgement within 7 days and a status update at least every
14 days until the report is closed. Please give us 90 days before public
disclosure, or less if we ship a fix sooner.

## Supported versions

Fixes land on the default branch and in the latest release. Older releases are
not patched. Self-hosted instances are expected to track releases, see
[Updates](https://www.motherbase.site/docs/getting-started/updates/).

## In scope

The API server, Platform Console and its orchestrator, Project Studio, the REST
engine and its RLS enforcement, the storage pipeline, edge functions and their
sandbox, the auth stack, the published packages (`@motherbase/client`,
`@motherbase/ssr`, `@motherbase/cli`, `@motherbase/ai`), and the deployment
assets under `deploy/` and `setup.sh`.

## Out of scope

- Findings that require an already-compromised host, or a deliberate operator
  misconfiguration documented as unsafe
- Missing hardening headers with no demonstrated impact, and automated scanner
  output with no working exploit path
- Denial of service by raw traffic volume against an instance you do not own
- Social engineering, and vulnerabilities in third-party services an operator
  chose to connect

## Operator responsibilities

Motherbase is self-hosted software: the security of a running instance also
depends on how it is deployed. Keep `JWT_SECRET` and `CONFIG_ENCRYPTION_KEY`
secret and unique per instance, never expose the Platform Console or the
database port to the public internet without TLS and access control, run the
deploy user as a non-root account, and keep the host patched. The full security model is documented at
[www.motherbase.site/docs/architecture/security-model](https://www.motherbase.site/docs/architecture/security-model).
