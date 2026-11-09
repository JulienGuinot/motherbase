import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

import {
  BLOCKS,
  escapeMdxSyntax,
  beginMarker,
  endMarker,
  compatibilityTable,
  cliOverviewTable,
  BACKEND_DIR,
  generatedBody,
  sourcePath,
  splice,
  targetPath,
} from '../../scripts/sync-backend-docs.mjs'

/**
 * Two reference tables are generated in the backend repository and only
 * transported here. The backend guards its own copies; nothing guarded these,
 * and both drifted:
 *
 * - the route table lost three controllers (`admin-auth`, `admin-content`,
 *   `admin-infrastructure`, 28 routes), so the reference claimed a smaller
 *   admin API than the product has;
 * - the compatibility matrix was retyped by hand and contradicted the contract
 *   test — `client.schema()` was called "not in this SDK" while the test
 *   asserts it calls functions in another schema.
 */
describe.each(BLOCKS as Array<{ marker: string; target: string }>)('%s', block => {
  const page = fs.readFileSync(targetPath(block), 'utf8')

  it('keeps both markers, exactly once each', () => {
    expect(page.split(beginMarker(block.marker))).toHaveLength(2)
    expect(page.split(endMarker(block.marker))).toHaveLength(2)
  })

  it('splices in place and is idempotent', () => {
    const once = splice(page, block.marker, '| a |')
    expect(splice(once, block.marker, '| a |')).toBe(once)
    expect(once).toContain('| a |')
  })

  it('refuses a page without the markers rather than appending a second table', () => {
    expect(() => splice('# No markers here', block.marker, '| a |')).toThrow(/markers/)
  })

  // Never skipped: the backend is the parent directory, so a stale table fails
  // every run, CI included. It used to skip when no sibling checkout existed,
  // which is every CI run, and the tables drifted unnoticed.
  it('matches the backend, row for row', () => {
    expect(page, 'stale: run `npm run docs:sync`').toBe(
      splice(page, block.marker, generatedBody(block, BACKEND_DIR)),
    )
  })
})

describe('compatibility matrix transform', () => {
  const source = [
    '<!--',
    '  GENERATED FILE. Do not edit by hand.',
    '-->',
    '',
    '# @motherbase/client vs supabase-js',
    '',
    'Every row is produced by a contract test.',
    '',
    'Totals: 70 supported, 25 partial, 1 not supported (96 rows).',
    '',
    '## Client',
    '',
    '| Test id | Surface | Status | Notes |',
    '| --- | --- | --- | --- |',
    '| `client.rpc` | `client.rpc(fn, args)` | Supported | Named arguments. |',
    '',
  ].join('\n')

  const table = compatibilityTable(source)

  it('drops the banner, the title and the standalone legend', () => {
    expect(table).not.toContain('GENERATED FILE')
    expect(table).not.toContain('# @motherbase/client vs supabase-js')
    expect(table).not.toContain('Totals:')
  })

  it('demotes the section headings under the page heading', () => {
    expect(table).toContain('### Client')
    expect(table).not.toMatch(/^## /m)
  })

  // The test id is the suite's handle on a row, not something a reader of the
  // page can use. Leaving it in put an opaque identifier in the first column of
  // every row of a 96-row table.
  it('drops the test id column from the header, separator and rows', () => {
    expect(table).toContain('| Surface | Status | Notes |')
    expect(table).toContain('| `client.rpc(fn, args)` | Supported | Named arguments. |')
    expect(table).not.toContain('Test id')
    expect(table).not.toContain('`client.rpc` |')
  })
})

/**
 * Every generator writes plain Markdown; every target is MDX. A note reading
 * `createClient<Database> types from() and rpc() from it`, or a usage string
 * carrying `--confirm <name>`, is an opening JSX tag with no close once it is
 * spliced. A note reading `{ auth: { persistSession } }` is a JSX expression
 * acorn cannot parse. Either one fails the docs build — the one gate neither
 * repository's test suite runs.
 */
describe('escapeMdxSyntax', () => {
  it('escapes a bare angle bracket', () => {
    expect(escapeMdxSyntax('createClient<Database> types from()')).toBe(
      'createClient&lt;Database&gt; types from()',
    )
  })

  // The compatibility matrix describes supabase-js option objects in prose.
  it('escapes a bare brace', () => {
    expect(escapeMdxSyntax('so { auth: { persistSession } } takes effect')).toBe(
      'so &#123; auth: &#123; persistSession &#125; &#125; takes effect',
    )
  })

  it('leaves a code span alone, brackets and braces included', () => {
    expect(escapeMdxSyntax('`motherbase domains create --custom-hostname <api.example.com>`')).toBe(
      '`motherbase domains create --custom-hostname <api.example.com>`',
    )
    expect(escapeMdxSyntax('`createClient(url, key, { db: { schema } })`')).toBe(
      '`createClient(url, key, { db: { schema } })`',
    )
  })

  it('escapes around a code span without touching it', () => {
    expect(escapeMdxSyntax('serve on <name> as in `--sub <name>`')).toBe(
      'serve on &lt;name&gt; as in `--sub <name>`',
    )
  })

  it('leaves a fenced block alone', () => {
    const fenced = '```ts\nconst a = <T>(x: T) => x\n```'
    expect(escapeMdxSyntax(fenced)).toBe(fenced)
  })
})

describe.each(BLOCKS as Array<{ marker: string; target: string }>)('%s is MDX-safe', block => {
  const body = () => {
    const page = fs.readFileSync(targetPath(block), 'utf8')
    const spliced = page.split(beginMarker(block.marker))[1].split(endMarker(block.marker))[0]
    return spliced.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  }

  it('carries no bare angle bracket outside a code span', () => {
    expect(body()).not.toMatch(/<[A-Za-z/!]/)
  })

  // Nothing generated is ever meant to be an MDX expression, so any brace that
  // survives the escaper is a build failure waiting in the published site.
  it('carries no bare brace outside a code span', () => {
    expect(body()).not.toMatch(/[{}]/)
  })
})

describe('CLI overview transform', () => {
  const source = [
    '<!-- GENERATED by `npm run docs:cli`. Do not edit by hand. -->',
    '',
    '# CLI commands',
    '',
    '| Command | Usage | What it does |',
    '|---|---|---|',
    '| `login` | `motherbase login` | Log in |',
    '| `db` | `motherbase db <push\\|pull> ...` | Database |',
    '| `db push` | `motherbase db push` | Apply migrations |',
    '| `db pull` | `motherbase db pull [name]` | Create a migration |',
  ].join('\n')

  const table = cliOverviewTable(source)

  it('writes one row per top-level command, in registry order', () => {
    expect(table.split('\n')).toEqual([
      '| Command | What it does | Subcommands |',
      '|---|---|---|',
      '| `login` | Log in | — |',
      '| `db` | Database | `push`, `pull` |',
    ])
  })
})
