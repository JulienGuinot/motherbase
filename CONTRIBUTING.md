# Contributing to Motherbase

Thanks for helping. This file covers what you need to get a working checkout and
what a pull request has to satisfy. The extended version lives at
[www.motherbase.site/docs/contributing/overview](https://www.motherbase.site/docs/contributing/overview).

## Prerequisites

- Node **>= 22.12.0** (`.nvmrc` and `.node-version` pin the exact version;
  `preinstall` refuses to run on anything older)
- Docker with Compose v2. The test suite talks to a real PostgreSQL
- `npm` (the repo is an npm workspaces monorepo; do not use pnpm or yarn)

## Getting a working checkout

```bash
npm run install:all                       # npm ci --legacy-peer-deps
cp apps/server/.env.example apps/server/.env
npm run infra                             # Postgres on :55432 + MinIO on :9000
npm run prisma:generate
npm run prisma:migrate
npm run dev                               # API on :5001
```

`npm run infra` builds the Postgres image the first time (it ships `pg_cron` and
`pg_stat_statements`, which the plain `postgres` image does not), so the first
run takes a few minutes.

Stop the infrastructure with `npm run infra:down`.

## Checks a pull request must pass

```bash
npm run lint
npm run build
npm test
```

CI runs the same three plus the SDK/API contract suite and a compatibility
matrix drift check. See `.github/workflows/ci.yml`, which is the authority on
what must be green.

**`npm test` requires the database to be up.** Integration tests connect to
`DATABASE_URL`, and without `npm run infra` running you get a wall of
`Can't reach database server at localhost:55432`. That is a missing container,
not a broken test.

Run a single file while iterating:

```bash
npx vitest run apps/server/tests/<file>.unit.test.ts
```

If you touched the client SDK surface, regenerate the compatibility matrix and
commit the result, because CI fails on drift:

```bash
npm run test -w @motherbase/server -- sdk-contract
```

## Conventions

- **TypeScript everywhere**, no `any` in new code.
- **Tests are not optional** for behaviour changes. Unit tests live next to the
  feature in `apps/server/tests/*.unit.test.ts`; anything touching the database
  goes in `*.integration.test.ts`.
- **Commits follow Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`),
  with a scope where it helps: `fix(api): serialize BigInt instead of 500ing`.
- **Database changes go through Prisma migrations.** Never edit an applied
  migration; add a new one with `npm run prisma:migrate`.
- **Settings belong in the settings system** (`apps/server/config/settings/`),
  not in new ad-hoc environment variables. Anything genuinely new in the
  environment must be added to `apps/server/config/env.ts` and to
  `apps/server/.env.example`.
- **Documentation lives in [`website/`](website/)**, next to the code. A
  user-visible change updates the matching page under `website/content/docs/` in
  the same pull request. See [website/CONTRIBUTING.md](website/CONTRIBUTING.md).

## Pull requests

Keep them focused: one concern per pull request. Describe what changed and why,
and how you verified it. Link the issue if there is one.

Preview environments: a pull request can get its own throwaway project stack, see
[Preview projects](https://www.motherbase.site/docs/console/preview-projects/).

## Reporting bugs

Open an issue with the version, how the instance is deployed (`setup.sh`, plain
Compose, development checkout), the steps, and the relevant server log lines.
**Do not open a public issue for a security vulnerability**. See
[SECURITY.md](SECURITY.md).
