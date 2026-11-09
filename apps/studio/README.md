# studio

The admin UI. One Next.js 15 / React 19 build, served only by the Platform Console
(`apps/server/console/server.ts`) under the fixed `basePath: '/studio'`
(`next.config.mjs`). It covers the org, projects, team, usage, billing and platform
settings, and each project's workspace (tables, SQL, auth, storage, realtime, logs,
edge functions) at `/p/<id>/...`, reached through the Console's admin proxy. A
project's API image carries no UI. See `docs/glossary.md`.

## Running it

```bash
npm run console:dev    # the Console the dev server proxies /api to (localhost:5500)
npm run studio:dev     # next dev on :5173, /api proxied to localhost:5500
npm run studio:mock    # the same with NEXT_PUBLIC_MOCK=1, no backend needed
npm run studio:build   # next build — required before the Console can mount /studio
npm test -w studio     # vitest, jsdom
```

`http://localhost:5173/studio` — `/` is a 404, the basePath is not optional.

Mock mode installs an MSW service worker answering from `src/mocks/handlers.ts`.
It is set through `scripts/dev-mock.mjs` rather than an inline `VAR=value` prefix,
which does not work on Windows.

Dev and production builds write to **different** directories (`.next-dev` and
`.next`), so a repo-root `npm run build` cannot overwrite a running dev server's
manifests.

## Layout

```text
app/                  Route files (App Router). (org)/ is the Console, p/[id]/ a project
src/shell/            Layout, OrgLayout, ProductLayout, ProjectGate, RequireAuth, NotFound
src/features/<name>/  api/ components/ hooks/ lib/ pages/ types.ts
src/shared/           ui/ hooks/ lib/ types/ — see src/shared/ui/README.md before adding markup
src/mocks/            MSW worker, handlers and fixtures
```

Features: `api-tools`, `assistant`, `auth`, `database`, `logs`, `platform`,
`projects`, `sql`, `storage`, `tables`.

## Conventions

- UI primitives and visual tokens: [`src/shared/ui/README.md`](src/shared/ui/README.md).
- Visual and structural rules: [`docs/DESIGN.md`](../../docs/DESIGN.md).
- Every project screen calls `/api/admin/*`. Under the Console those are proxied
  as `/api/projects/:id/admin/*`.
- Optimistic cache writes must snapshot and restore `onError` (`AGENTS.md`, rule 10).
