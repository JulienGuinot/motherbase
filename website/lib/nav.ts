import { cache } from 'react'

import { getAllDocSlugs, getDocBySlug } from './mdx'

export interface NavItem {
  title: string
  href: string
  slug: string[]
  description: string
}

export interface NavGroup {
  label: string
  dir: string
  items: NavItem[]
}

// Reading order for a newcomer: run it, build on it, operate it, look things up,
// then the internals. The pager follows this order too.
const GROUP_ORDER: { label: string; dir: string }[] = [
  { label: 'Getting Started', dir: 'getting-started' },
  { label: 'Example', dir: 'example' },
  { label: 'Platform', dir: 'platform' },
  { label: 'Project Studio', dir: 'studio' },
  { label: 'Platform Console', dir: 'console' },
  { label: 'CLI', dir: 'cli' },
  { label: 'Packages', dir: 'packages' },
  { label: 'Self-hosting', dir: 'self-hosting' },
  { label: 'Reference', dir: 'reference' },
  { label: 'Architecture', dir: 'architecture' },
  { label: 'Contributing', dir: 'contributing' },
]

// Titles and ordering come from each page's frontmatter (`title`, `order`).
export const buildNav = cache(function buildNav(): NavGroup[] {
  const slugs = getAllDocSlugs()

  return GROUP_ORDER.map(({ label, dir }) => {
    const items = slugs
      .filter(slug => slug[0] === dir)
      .map(slug => {
        const doc = getDocBySlug(slug)
        return {
          title: doc?.frontmatter.title ?? slug[slug.length - 1],
          href: '/docs/' + slug.join('/'),
          slug,
          description: doc?.frontmatter.description ?? '',
          order: doc?.frontmatter.order ?? 999,
        }
      })
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
      .map(({ title, href, slug, description }) => ({ title, href, slug, description }))

    return { label, dir, items }
  }).filter(group => group.items.length > 0)
})
