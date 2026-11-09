import { cache } from 'react'
import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'

const DOCS_DIR = path.join(process.cwd(), 'content', 'docs')

export interface DocFrontmatter {
  title: string
  description: string
  order?: number
}

export interface DocFile {
  slug: string[]
  frontmatter: DocFrontmatter
  rawContent: string
}

export function getAllDocSlugs(): string[][] {
  const slugs: string[][] = []

  function walk(dir: string, parts: string[]) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), [...parts, entry.name])
      } else if (entry.name.endsWith('.mdx')) {
        slugs.push([...parts, entry.name.replace(/\.mdx$/, '')])
      }
    }
  }

  walk(DOCS_DIR, [])
  return slugs
}

// Cached per request: one docs page renders DocsLayout (which walks every
// doc to build the nav) and then reads its own doc again, and llms-full.txt
// re-reads all ~75 files that buildNav just read. That is a readFileSync plus
// a gray-matter parse each time. Per request, not module-level, so editing a
// doc in dev still shows up without restarting the server.
export const getDocBySlug = cache(function getDocBySlug(slug: string[]): DocFile | null {
  const filePath = path.join(DOCS_DIR, ...slug) + '.mdx'
  if (!fs.existsSync(filePath)) return null

  const raw = fs.readFileSync(filePath, 'utf-8')
  const { data, content } = matter(raw)

  return {
    slug,
    frontmatter: data as DocFrontmatter,
    rawContent: content,
  }
})
