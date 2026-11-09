# Glossary

Motherbase has two operator-facing products that ship from **one** React bundle.
That is the single biggest source of naming confusion in this repo, so the terms
below are binding: use them in code, comments, docs, and UI copy.

## The two products

| Term | What it is | Backend | Served at |
|---|---|---|---|
| **Platform Console** | Multi-project control plane. Create, start, update, back up, and tear down project stacks. Orgs, team, billing, fleet logs. | `apps/server/console/` (its own Node process) | `console.example.com/studio` |
| **Project Studio** | Single-project workspace. Tables, SQL, auth, storage, edge functions, logs for one project. | that project's API server, `apps/server/app.ts`, reached through the Console's admin proxy | `console.example.com/studio/p/<project>` |

A project's API image carries no UI: the Console is always present and is the
only process that serves `apps/studio/`. A project's own domain serves the API
only, and `<project>.example.com/studio` is a 404.

Both products render from `apps/studio/` (workspace name `studio`), a Next app
whose `basePath` is fixed at `/studio` in `next.config.mjs`. They are two areas of
one app, not two modes: the Platform Console is the org-level routes, Project
Studio is the `/p/<id>/...` routes.

The Console server 308-redirects anything outside `/studio`, including the bare `/`
and the legacy `/console` mount, to `/studio`.

## Rules

- Never write "console" alone for the SPA. It is either the **Platform Console**
  (the product), `apps/server/console/` (the control-plane server), or
  `deploy/console/` (that server's Compose stack).
- Never write "studio" alone for the whole UI. It is either **Project Studio**
  (the product) or `apps/studio/` (the workspace shipping both products).
- `Motherbase` is the brand. It is the `<title>` and the wordmark, not a product name.
- `prisma studio` (npm script `prisma:studio`) and the MinIO console
  (`MINIO_CONSOLE_PORT`) are third-party tools. Unrelated to either product.

## Legacy spellings still in the tree

| Spelling | Where | Status |
|---|---|---|
| `/console` as the Studio mount | old bookmarks | redirected by the Console server, do not add new uses |
| `consoleUrl` / `studioUrl` on a project manifest | `manifest.json` on existing installs | ignored, nothing reads them |
| `consoleUrl` in the CLI config | `packages/cli` | **correct**, that one really is the Platform Console URL |
