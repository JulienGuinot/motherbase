import { buildNav } from '@/lib/nav'
import { REPO_URL, SITE_URL } from '@/lib/site'

export const dynamic = 'force-static'

// Generated from the docs tree so new pages never need a manual llms.txt edit.
// Follows the llms.txt convention: one `- [Title](url): description` per page,
// so an agent can pick the right page from this file alone instead of fetching
// every link to find out what it is.
export function GET() {
  const sections = buildNav()
    .map(
      group =>
        `### ${group.label}\n` +
        group.items
          .map(item => `- [${item.title}](${SITE_URL}${item.href}): ${item.description}`)
          .join('\n'),
    )
    .join('\n\n')

  const body = `# Motherbase

> Open source, self-hosted backend platform. Run many isolated projects from one VPS and one
> domain. Postgres with native row-level security, Better Auth, storage, realtime, edge
> functions, triggers, cron, a Studio admin UI, a Supabase-compatible client SDK, a
> multi-project Platform Console and an operator CLI. MIT licensed, TypeScript and Node.js.

The API dialect is PostgREST-compatible and the client SDK is shaped like supabase-js, so
Supabase knowledge transfers directly — but authorization is real PostgreSQL RLS, not an
application-layer check. Read [REST API](${SITE_URL}/docs/reference/rest-api/) and
[RLS](${SITE_URL}/docs/platform/rls/) before generating any data-access code.

The entire documentation set is also served as one plain-text file at
${SITE_URL}/llms-full.txt (~500 KB). Prefer it when you need broad context in a single
fetch; use the per-page links below when you already know which page you want.

Known defects are listed, in full and on purpose, at
${SITE_URL}/docs/contributing/known-issues/ — read it before asserting that something works.

## Documentation

${sections}

## Source

${REPO_URL}
`

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
