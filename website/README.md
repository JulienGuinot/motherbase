# Motherbase website

Marketing and documentation site for [Motherbase](https://www.motherbase.site), served at
www.motherbase.site. It lives next to the code it documents so that a change and its
documentation land in the same pull request, and so that an agent reading the repository
sees both. It is not part of the product: `.dockerignore` keeps it out of every image, the
install bundle never contains it, and it is not an npm workspace of the backend.

Built with Next.js 15 App Router, fully statically exported, MDX docs, and Tailwind CSS v4.

## What's in here

```
app/
  page.tsx              # Marketing homepage
  docs/[...slug]/       # MDX docs renderer (SSG)
  example/              # Interactive todo demo

  llms.txt/route.ts     # llms.txt, generated from the docs tree
  llms-full.txt/route.ts # the same tree with full page bodies

content/docs/
  getting-started/      # Overview, quickstart, frameworks, deploy, updates, Supabase migration, for AI agents
  architecture/         # Request lifecycle, settings, data model, security, REST engine,
                        #   edge runtime, background jobs, storage pipeline
  platform/             # Auth, API keys, database, RLS, storage, realtime, edge functions, triggers,
                        #   cron, AI assistant, MCP, notifications, webhooks, Git migrations,
                        #   observability, integrations (Vault, Wrappers)
  studio/               # Every Project Studio screen
  console/              # Platform Console: projects, preview projects and branches, orchestration,
                        #   users, audit, monitoring, proxy, API
  cli/                  # CLI overview, getting started, commands
  packages/             # client, ssr, ui, create-app, ai, contracts, cli internals
  self-hosting/         # setup.sh, Docker, Traefik, operations, backups, upgrades, troubleshooting
  reference/            # SDK, REST API, admin API, settings, environment, errors, OpenAPI
  contributing/         # Repo layout, development, testing, conventions, known issues
  example/              # Todo app walkthrough

components/             # Nav, Sidebar, Callout, CodeBlock, etc.
lib/
  mdx.ts                # MDX loading + frontmatter
  nav.ts                # Sidebar navigation tree (groups + frontmatter-driven order)
  toc.ts                # Heading extraction for the table of contents
  code-theme.ts         # Shiki theme wiring for CodeBlock
  site.json / site.ts   # Repo URL and package names, shared with next-sitemap
```

## Development

```bash
npm install
npm run dev
# → http://localhost:3000
```

## Build

```bash
npm run build
```

Docs pages are prerendered with `generateStaticParams`, and `postbuild` runs `next-sitemap`. Two things are **not** static: the interactive `/example` demo (server-rendered on demand, it talks to a live backend) and `middleware.ts`, which runs on the Node.js runtime because the SDK's realtime module pulls in `socket.io-client`. Deploy on a host that runs Next.js, not a pure static bucket.

## Environment

Copy `.env.example` to `.env.local` and fill in:

```env
NEXT_PUBLIC_MOTHERBASE_URL=http://localhost:5001
SITE_URL=https://www.motherbase.site
```

`SITE_URL` is used by `next-sitemap` to generate the sitemap and robots.txt — `.env.example` ships the localhost value, so a production build must override it or the sitemap points at localhost. `NEXT_PUBLIC_MOTHERBASE_URL` is used by the interactive example/demo. The repository URL and package names are constants in `lib/site.json`, read by both `lib/site.ts` and `next-sitemap.config.js`.

## Testing

```bash
npm test
```

Tests live in `lib/__tests__/` and cover the MDX pipeline (`mdx.test.ts`), MDX syntax that only `next build` would reject (`mdx-safety.test.ts`), the sidebar tree (`nav.test.ts`), the table of contents (`toc.test.ts`), the site constants (`site.test.ts`) and the freshness of the five blocks generated in the backend (`sync-backend-docs.test.ts`).

## Docs content

All documentation lives in `content/docs/` as MDX files. Frontmatter fields:

```yaml
---
title: "Page title"
description: "Short description shown in meta tags and search."
order: 3
---
```

Adding a page is enough to publish it: `lib/nav.ts` discovers every `.mdx` file, takes its label from `title` and its position from `order` (missing `order` sorts last, then alphabetically). `lib/nav.ts` only owns the **group list** — the section directories and their labels, in sidebar order. A group with no pages is hidden.

`app/llms.txt/route.ts` renders `llms.txt` from the same tree, and `app/llms-full.txt/route.ts` the same tree with full page bodies, so neither needs a manual edit.

Allowed MDX components are `<Note>`, `<Warning>` and `<Flag>` (see `app/docs/[...slug]/page.tsx`). Do not `import` inside an MDX file.

## Deployment

Deploy on a host that runs Next.js. On Vercel, set the project's **Root Directory** to
`website` and nothing else. A pure static bucket would drop `/example` and the middleware.

Set `SITE_URL` at build time so `next-sitemap` writes the right sitemap and `robots.txt`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The repository's CI runs `npm run lint`,
`npx tsc --noEmit`, `npm test` and `npm run build` here on every pull request.

`npm run docs:sync` copies the five generated tables from the backend (this
directory's parent) into the pages that show them. Regenerate them in the backend
first: `npm run docs:routes`, `npm run docs:cli` and `npm run docs:settings` there,
and the `sdk-contract` test for `packages/client/COMPATIBILITY.md`. `npm test` here
fails when any block is stale.

Security reports go through the repository's [SECURITY.md](../SECURITY.md), never a
public issue. MIT licensed, see [LICENSE](../LICENSE).
