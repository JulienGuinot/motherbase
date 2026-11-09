import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * MDX parses JSX in prose, so a bare `<Database>` or `--confirm <name>` outside
 * a code span is an opening tag with no close, and the page fails `next build`.
 *
 * That is the only gate that catches it, it runs after both test suites, and it
 * had to catch it: the generated compatibility matrix carries
 * `createClient<Database> types from() and rpc()` and the generated CLI table
 * carries `--confirm <name>`, both perfectly valid in the Markdown the backend
 * writes. These tests move the failure into `npm test`, for generated blocks and
 * hand-written prose alike.
 *
 * The component list mirrors `app/docs/[...slug]/page.tsx`. A new component has
 * to be registered there before a page may use it, and this test is what says
 * so.
 */
const COMPONENTS = ['Note', 'Warning', 'Flag']

// Vitest runs from the repository root (see vitest.config.ts).
const DOCS_DIR = path.join(process.cwd(), 'content', 'docs')

function docFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return docFiles(full)
    return entry.name.endsWith('.mdx') ? [full] : []
  })
}

/** Prose only: fenced blocks and code spans are where JSX is not parsed. */
function prose(source: string): string {
  return source.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
}

describe('docs are valid MDX', () => {
  const files = docFiles(DOCS_DIR)

  it('finds the docs', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it.each(files.map(file => [path.relative(DOCS_DIR, file), file]))(
    '%s uses no unregistered JSX tag in prose',
    (_name, file) => {
      const found = [...prose(fs.readFileSync(file, 'utf8')).matchAll(/<\/?([A-Za-z][A-Za-z0-9]*)/g)]
        .map(match => match[1])
        .filter(tag => !COMPONENTS.includes(tag))
      expect([...new Set(found)]).toEqual([])
    },
  )

  // An odd number of fences means one block never closes, and everything after
  // it renders as code.
  it.each(files.map(file => [path.relative(DOCS_DIR, file), file]))(
    '%s closes every code fence',
    (_name, file) => {
      const fences = (fs.readFileSync(file, 'utf8').match(/^```/gm) ?? []).length
      expect(fences % 2).toBe(0)
    },
  )
})
