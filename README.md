<p align="center">
  <img src="docs/assets/logo.png" alt="Motherbase" width="96">
</p>

# Motherbase

**The control plane self-hosted Supabase never shipped.**

One VPS. One wildcard DNS record. As many isolated projects as you want, each with
its own Postgres, storage, API, auth and Studio.

You know the moment. A second client signs. You open the folder with the
`docker-compose.yml` that took a weekend to get right, you copy it, you change the
ports, you change the JWT secret, you forget to change one of them, and now you run
two backends. A year later you run nine, the ports are a spreadsheet, and the only
system that knows how any of it is wired is you, on a Tuesday, from memory.

Motherbase makes the project the unit. A Platform Console creates, updates, backs
up and destroys project stacks from a single install, routed by Traefik on
subdomains of one wildcard record.

```text
console.example.com      Platform Console (create and operate projects)
client-a.example.com     project: isolated Postgres + storage + API + Studio
client-b.example.com     project: isolated Postgres + storage + API + Studio
```

A new project needs no new DNS record, no new certificate, and no Compose file
written by hand at 1am.

## The things that made us build this

None of this is a swipe at Supabase, which is genuinely good software and where a
lot of this design comes from. These are the specific places where **self-hosting
it** hurts, and what we do about each.

| The part that hurts | What Motherbase does instead |
|---|---|
| **One project per stack.** Self-hosted Supabase is a single project. Client number two means a whole second copy of everything, hand-wired, with no shared place to see or operate them. | Projects are first class. The Console provisions them, and they share one install, one Traefik, one wildcard record. |
| **"Back up and pray" upgrades.** Version coupling between a dozen images, tags that move under you, migrations that do not replay onto an existing volume. | One scripted path that keeps your volumes: `./deploy/update.sh` for the platform, one command per project for the rest. You choose when each client moves. |
| **MFA and SAML SSO live on the invoice.** Hosted, they sit behind the paid tiers. Self-hosted, you assemble them yourself. | TOTP with backup codes and trusted devices, passkeys, per-organization SSO, organizations, API keys. Every project, no tier, configured from Studio. |
| **The self-hosted dashboard is the demo version.** Half the screens you use in the cloud are simply not there, and logs want a separate analytics stack before they show you anything. | Project Studio is the same product locally and in production: tables, SQL, auth, storage, realtime, policies, logs, advisor, backups, edge functions. |
| **"It is just Postgres"** turns out to be Kong plus nine services you now operate, none of which you picked. | Still Postgres, plus one Node API server per project. Real `CREATE POLICY` RLS, not an application-level policy DSL. |
| **Default keys.** Every self-host guide ships the same demo JWT secret, and a depressing number of installs are still running it. Internet-wide scanners know this. | `setup.sh` generates every secret for your install. The bootstrap console password is temporary and must be replaced before the first real action. |
| **Somebody else's account can pause your project.** Region, jurisdiction and the power to suspend you are theirs, and it all goes in the DPA. | Postgres, storage, auth and every key sit on infrastructure you picked, where you picked it. Backups are yours, on a schedule you set. |
| **Writing the RLS policy is the easy half.** Re-reading a policy expression only tells you what you meant, not what it does. | An RLS simulator that really executes your query as the caller you name, inside a transaction that always rolls back, and tells you which gate closed. |

If you want a free hosted backend for one side project and you would rather not
administer a server, a hosted free tier is honestly the better deal, and we are not
going to pretend otherwise. This is built for the other case.

## Who this is for

- **Agencies and freelancers hosting several clients.** One VPS, one install, one
  bill, one operational surface. Each client gets an isolated database and a Studio
  you can hand over without handing over everything else.
- **Companies under GDPR or data residency constraints.** The stack runs on
  infrastructure you choose, in the jurisdiction you choose. No third-party control
  plane holds your data, your keys, or the ability to switch you off.
- **Teams that want enterprise auth without an Enterprise plan.** MFA, passkeys,
  SSO, organizations and API keys, on every project, at no tier.

## Enterprise auth, included

Assembled in `apps/server/auth/instance.ts`, configured per project from Project
Studio. Nothing here is an add-on, an upsell, or a plugin you have to go source
yourself.

| Capability | Detail |
|---|---|
| Two-factor (TOTP) | Configurable digits and period, **backup codes**, **trusted devices** with a configurable trust window, plus optional second-factor OTP over email or SMS |
| Passkeys | WebAuthn sign-in and registration, with configurable relying party |
| SSO | Enterprise single sign-on, including per-organization SSO |
| Organizations and teams | First-class organizations, membership, and teams |
| API keys | Machine-to-machine authentication, issued and revoked through the auth API |
| Magic link | Passwordless sign-in by email link |
| Email OTP | One-time codes for sign-in, verification, and password recovery |
| Phone and SMS OTP | Sign-in and sign-up by phone number, with optional phone-only registration |
| Social sign-in | 18 built-in providers (Google, Apple, GitHub, Microsoft, Discord, GitLab, LinkedIn, and more) |
| Generic OIDC / OAuth2 | Any provider, by discovery URL or explicit endpoints |
| Tokens | JWT access tokens with published JWKS, custom claims, configurable lifetimes, bearer and cookie transport |
| Hooks | A "before user created" gate that can refuse a sign-up, and an auth event webhook |

Per-project surfaces for all of it live in Project Studio under **Authentication**:
users, providers, MFA, passkeys, organizations, sessions, hooks, policies and
settings. Transactional emails are edited in the same place and apply on the next
send, no restart. See [docs/email-templates.md](docs/email-templates.md).

## Upgrades you run, not upgrades you survive

One scripted path, and it keeps your project volumes:

```bash
./deploy/update.sh               # platform: pull, images, Traefik, Console
motherbase projects update <id>  # or the Console "Update" action, per project
```

`setup.sh` keeps existing environment files, rebuilds the shared images, and
recreates Traefik and the Console without touching project data. Project updates are
per project, so a client sitting on a delicate release stays where they are. See
[Updates](https://www.motherbase.site/docs/getting-started/updates/) for rebuilds,
migrations and rollback.

---

## Try it, without cloning

One project, on your machine, with nothing installed but Docker:

```bash
npx @motherbase/cli init my-backend
cd my-backend
npx @motherbase/cli start
```

`init` writes a `docker-compose.yml` and a `.env` with secrets generated for this
install, and prints the API URL and the first operator's credentials. `start` pulls
the published images and brings the stack up. Create the operator account once with
`docker compose exec api node apps/server/dist/prisma/seed.js`.

That gets you a single project's API, Postgres, storage and edge runtime, with **no
Project Studio**: Studio is served by the Platform Console. The multi-project Console
below is the part that is actually the point.

## Install

There is one supported way to install and run the multi-project platform:

```bash
./setup.sh
```

The script handles the environment file, secrets, Docker runtime, Traefik, images,
Console startup, health checks and the Platform Console admin account.

To install on a VPS without cloning, run the installer. It downloads the bundle CI
publishes next to the prebuilt images (`setup.sh` and `deploy/` only, so nothing is
compiled), refuses it unless its SHA-256 matches the published digest, unpacks it
into `~/motherbase` and runs `setup.sh` there in VPS mode. `./deploy/update.sh`
fetches and verifies the same bundle again later:

```bash
curl -fsSL https://www.motherbase.site/install.sh | bash
```

Useful flags:

```bash
./setup.sh --yes
./setup.sh --reset
DOMAIN=example.com ACME_EMAIL=admin@example.com ./setup.sh --yes
```

Choose **Local** for development. The Console starts at:

```text
http://localhost:5500/studio
```

Choose **VPS** for production. The Console starts at:

```text
https://console.example.com
```

Setup generates a strong random Platform Console password when none is provided. It
prints that password once and never echoes one supplied through `ADMIN_PASSWORD`.
Generated bootstrap passwords are temporary: the Console only lets you replace them
before any project or administration action.

For an unattended production install, either let setup generate the secret or
provide a unique password of at least 16 characters:

```bash
DOMAIN=example.com ACME_EMAIL=admin@example.com \
  ADMIN_PASSWORD='your-unique-strong-password' ./setup.sh --yes --prod
```

## VPS DNS

Configure DNS once, with a wildcard record:

```dns
Type:  A
Name:  *
Value: <VPS_IP>
```

If your provider wants a hostname target instead of an IP, use a wildcard `CNAME`:

```dns
Type:  CNAME
Name:  *
Value: target.example.net
```

For `example.com`, that covers:

```text
console.example.com
demo.example.com
demo-storage.example.com
demo-minio.example.com
```

After that, creating `demo`, `client-a`, or any other project from the Console needs
no further DNS change. Traefik routes by host and issues TLS certificates
automatically.

Notes:

- `*.example.com` does not cover `example.com` itself. It never has, and it will
  catch you once.
- Explicit DNS records override the wildcard.
- If the Console domain is outside the base domain, `setup.sh` prints the extra
  record it needs.
- Custom external domains like `client.com` still need a record owned by that client.

## Creating projects

Open the Platform Console and create a project. In local mode, projects route as:

```text
http://<name>.localhost
```

In VPS mode:

```text
https://<name>.example.com
```

Each project gets its own isolated Postgres, storage and API, and opens in Project Studio from the Console.

## AI assistant

Project Studio includes a server-side assistant for inspecting schemas, data, logs
and project configuration. The operator supplies the model API key in project
settings. Anthropic, OpenAI and Google Gemini are supported, along with DeepSeek,
Qwen, GLM (Z.ai), Kimi (Moonshot), Mistral, xAI Grok, Groq and OpenRouter, whose
endpoints are prefilled, and any other OpenAI-compatible server by base URL.

The assistant reuses the authenticated admin API instead of opening a second path
into the database. Read tools run directly. Write actions are presented as proposals
and are never applied on their own, because an LLM with `DROP` is a story you only
get to tell once.

## What is included

- **Auth**: the full list above, per project, configured from Studio.
- **Database**: PostgreSQL with SQL editor, Table editor, extensions, indexes,
  functions, triggers, cron jobs, migrations and backups from Project Studio.
- **RLS**: native PostgreSQL row-level security with `anon`, `authenticated`,
  `auth.uid()`, `auth.jwt()` and real `CREATE POLICY` rules.
- **REST API**: automatic table/model API under `/rest/v1/:model`, enforced by
  PostgreSQL RLS.
- **API keys**: a publishable key for your frontend, and secret keys that run as
  `service_role` and bypass RLS for trusted server code. Revocable per caller, with
  no policy change. See [API keys](https://www.motherbase.site/docs/platform/api-keys/).
- **Direct database access**: the Console allocates each project a host port from
  `54320-54419` and binds it to `127.0.0.1`, so Prisma, Drizzle, psql or a BI client
  connect over an SSH tunnel. The connection string is on Project Studio's Connect page.
- **Storage**: local or S3-compatible storage such as MinIO, AWS S3 or R2.
- **Realtime**: broadcast, presence, and RLS-filtered `postgres_changes` over
  Socket.IO with JWT authentication.
- **Edge functions**: Deno, one process per function with a hard memory cap
  and a real timeout, an SSRF-guarded `fetch`, `npm:`/`jsr:` imports and
  `sendMail()` on the project's own SMTP. See
  [Edge functions](docs/edge-functions.md).
- **Observability**: request and database metrics, logs, an advisor that lints your
  schema and policies, and webhooks.
- **Project Studio**: admin UI for tables, auth, storage, SQL, logs, realtime,
  policies, webhooks, edge functions, settings and connection snippets.
- **Client SDK**: `@motherbase/client` in `packages/client`.
- **Preview projects**: one isolated stack per pull request, provisioned from a
  GitHub webhook and destroyed when the PR closes. See
  [Preview projects](https://www.motherbase.site/docs/console/preview-projects/).
- **MCP server**: `motherbase mcp` gives an AI agent your schema, the policy lint,
  the RLS simulator and, with `--write`, real DDL through migrations. See
  [MCP server](https://www.motherbase.site/docs/platform/mcp/).
- **Operator CLI**: `@motherbase/cli`, over 40 commands covering projects, db,
  migrations, rls, users, storage, functions, secrets, realtime, webhooks, cron,
  config, logs and import.
- **Platform Console**: multi-project provisioning and operations.
- **Supabase import**: CLI and admin import for schema, data, RLS policies,
  email/password users, storage buckets and their files, Edge Functions and
  project secrets.

## Coming from Supabase

Preview first, so you can see what lands before anything does:

```bash
motherbase import --from-supabase "$SUPABASE_DB_URL" --preview --json
```

Then import into the linked project:

```bash
motherbase import --from-supabase "$SUPABASE_DB_URL" --yes
```

Three parts of a Supabase project are not in its database, so each needs its own
credential. Add them and they come over too:

```bash
motherbase import --from-supabase "$SUPABASE_DB_URL" \
  --service-role-key "$SUPABASE_SERVICE_ROLE_KEY" \
  --management-token "$SUPABASE_ACCESS_TOKEN" --yes
```

| Section | Where Supabase keeps it | What it needs |
| --- | --- | --- |
| Schema, data, RLS policies, `auth.users` | the database | the connection URI |
| Storage buckets | the database (`storage.buckets`) | the connection URI |
| Storage files | the Storage API | `--service-role-key` |
| Edge Functions | the Management API | `--management-token` |
| Project secrets | the Management API | `--management-token` |

Leave a credential out and that section reports what it could not read; the rest
of the import still lands.

Edge Functions run as written: both runtimes are Deno, so `Deno.serve()`,
`Deno.env.get()` and `npm:`/`jsr:`/URL imports need no porting. One that fails
the deploy check is imported **disabled** with its source intact and the reason
named. Two honest limits: `SUPABASE_*` secrets are skipped deliberately, because they point at the project
you are leaving. Auth provider settings are still not copied.

## Client SDK

Build the SDK:

```bash
npm run sdk:build
```

Usage:

```ts
import { createClient } from '@motherbase/client';

// The publishable key is on Project Studio's Connect page.
const client = createClient('https://demo.example.com', 'mb_publishable_...');

// Auth is Better Auth's own client: every Better Auth method, under its own name.
await client.auth.signIn.email({
  email: 'admin@example.com',
  password: process.env.MOTHERBASE_PASSWORD!,
});

const { data: products } = await client.from('products').select('*').limit(10);
```

If that looks familiar, that is deliberate. See
[SDK reference](https://www.motherbase.site/docs/reference/sdk/) and
[packages/client/README.md](packages/client/README.md) for the API and the current
per-method status.

## Row level security

Motherbase uses real PostgreSQL RLS for REST table access. The old `api_policies`
table and the application-level policy DSL are gone.

Data requests run through `lib/rls-pool.ts`: each request opens a transaction, sets
the PostgreSQL role to `anon` or `authenticated`, injects JWT claims into
`request.jwt.claims`, then lets PostgreSQL evaluate table policies. Prisma stays on
the control plane for auth, settings, Console, Studio and internal tables.

Create policies from **Project Studio > Database > SQL** or **Project Studio >
Policies**:

```sql
CREATE TABLE todo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  user_id text NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE todo ENABLE ROW LEVEL SECURITY;

-- Each user sees, edits and deletes only their own rows. No anon policy,
-- so signed-out requests match nothing and are blocked.
CREATE POLICY "todo owner access"
ON todo
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
```

Tables created from the Studio SQL or Table editor get RLS enabled automatically.
With RLS on and no policies, REST returns no rows. With RLS off, the table is
effectively open through REST, because the data-plane roles have broad grants.

### RLS you can actually verify

Writing the policy is the easy half. The hard half is knowing it does what you meant,
and re-reading the expression only tells you what you meant.

**The simulator runs your query as the caller you name.** Not a prediction: the
statement really executes with `SET LOCAL ROLE` and those claims in
`request.jwt.claims`, inside a transaction that is always rolled back.

```bash
motherbase rls simulate --sql "select * from todo" --as anon          # 0 rows
motherbase rls simulate --sql "select * from todo" --as usr_0193abc   # their rows
```

Alongside the rows it names **which policies were in a position to decide**, and
which of the two independent gates closed when you see nothing: a missing `GRANT`
(Postgres raises) or a missing policy (silently 0 rows). Compare two callers and it
shows the rows one sees and the other does not, which is the actual answer to "why
is this row hidden".

**Presets are parameterised**, so they fit your column names, and they fix the grants
at the same time as the policies:

```bash
motherbase rls preset todo owner_only --owner-column user_id
```

`owner_only`, `org_scoped`, `public_read_owner_write` and `soft_delete`, alongside the
fixed originals `starter`, `public_crud`, `authenticated_crud`, `admin_only` and
`blocked`.

**The advisor names the leaks**, including the ones that are invisible in a policy
list: a policy that decides access by joining a table with RLS off, a
`SECURITY DEFINER` function `anon` can call, a policy filtering on an unindexed
column.

```bash
motherbase rls lint --level critical
```

In Studio, **Authentication > Role Access** answers the everyday version of the
question without a query: one grid per table of what `anon` and `authenticated` can
read, insert, update and delete, and which grant or policy decides each cell.

See [Row level security](https://www.motherbase.site/docs/platform/rls/) for the detailed
architecture and the SQL policy workflow.

## Project layout

npm workspaces monorepo: the API server and Console are apps, the CLI and client SDK
are publishable packages.

```text
apps/server/                API server + Platform Console (@motherbase/server)
  controllers/              Express route controllers
  services/                 Business logic and admin services
  services/rest-api/        Automatic REST API and PostgREST-style parser
  services/storage/         Local and S3 storage drivers
  services/admin/           Project Studio admin services, SQL, RLS, Advisor, Shield
  middlewares/              Auth, roles, request logging, rate limiting, validation
  prisma/                   Internal schema, migrations, seed
  console/                  Multi-project Platform Console
  lib/                      Prisma client, RLS pool, JWT claim mapping, telemetry
  config/                   Env validation and OpenAPI config
  tests/                    Vitest unit and integration tests
apps/studio/                Next.js Console and Project Studio UI, served by the Console (basePath /studio)
packages/client/            Typed client SDK (@motherbase/client)
packages/ssr/               Next.js SSR helpers for the SDK (@motherbase/ssr)
packages/contracts/         Request/response contracts shared by server and SDK
packages/cli/               Operator CLI (@motherbase/cli)
packages/ai/                Provider-agnostic agent loop used by the assistant
deploy/                     Internal Compose and Traefik files used by setup.sh
docs/                       Generated references (CLI, admin routes, settings) and a few guides
```

## Documentation

The full documentation site lives in [`website/`](website/), next to the code, and is
published at [www.motherbase.site/docs](https://www.motherbase.site/docs). It covers every package and
feature:

| Section | Contents |
|---|---|
| [Getting started](https://www.motherbase.site/docs/getting-started/overview) | Overview, quickstart, deploy, updates, Supabase migration |
| [Architecture](https://www.motherbase.site/docs/architecture/overview) | Request lifecycle, settings system, data model, security model, REST engine, edge runtime, background jobs, storage pipeline |
| [Platform](https://www.motherbase.site/docs/platform/auth) | Auth, database, RLS, storage, realtime, edge functions, triggers, cron, AI assistant, notifications, webhooks, observability, integrations |
| [Project Studio](https://www.motherbase.site/docs/studio/overview) | Every admin screen and the API it calls |
| [Platform Console](https://www.motherbase.site/docs/console/overview) | Projects, orchestration daemon, users and orgs, monitoring, audit log, proxy, API |
| [CLI](https://www.motherbase.site/docs/cli/overview) | Command reference and codegen |
| [Packages](https://www.motherbase.site/docs/packages/overview) | `client`, `ssr`, `ai`, `contracts`, `cli` internals |
| [Self-hosting](https://www.motherbase.site/docs/self-hosting/overview) | setup.sh, Docker topology, Traefik/TLS, operations, backups, upgrades, troubleshooting |
| [Reference](https://www.motherbase.site/docs/reference/sdk) | SDK, REST API, admin API, settings, environment, errors, OpenAPI |
| [Contributing](https://www.motherbase.site/docs/contributing/overview) | Repo layout, local development, testing and CI, conventions |

Kept in this repository, next to the code they describe:

- [Setup](SETUP.md)
- [Edge functions](docs/edge-functions.md)
- [Transactional email templates](docs/email-templates.md)
- [Per-organization SSO](docs/auth/per-organization-sso.md)
- [Publishing the SDK](docs/publishing-the-sdk.md)
- [Glossary](docs/glossary.md)
- Generated, never edited by hand: [CLI commands](docs/cli-commands.md),
  [admin routes](docs/admin-routes.md), [settings](docs/settings.md)

## Checks

```bash
npm run install:all  # Node >= 22.12.0
npm run infra        # Postgres + MinIO, needed by the integration tests
npm run verify       # lint && build && test
```

`npm run build` is the one that matters most, because it is the one the Dockerfile
runs. A green `tsc --noEmit` in a single workspace has never once saved a deploy.

## Contributing

Setup, the checks a pull request has to pass, and the conventions are in
[CONTRIBUTING.md](CONTRIBUTING.md). Behaviour in the community is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

Found a vulnerability? Please do not open a public issue. Follow
[SECURITY.md](SECURITY.md) instead.

## License

MIT. See [LICENSE](LICENSE). Take it, run it, host your clients on it.
