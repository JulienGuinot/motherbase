import { buildNav } from '@/lib/nav'
import { getDocBySlug } from '@/lib/mdx'
import { SITE_URL } from '@/lib/site'

export const dynamic = 'force-static'

// The whole documentation set as one plain-text fetch, in sidebar order.
// An agent answering a question about Motherbase would otherwise have to crawl
// 75 pages to find out which one it needs; this is the single-request path.
// Pages are emitted verbatim (MDX minus frontmatter) — the <Note>/<Warning>/<Flag>
// tags are left in place because they mark exactly the caveats a generator
// should not silently drop.
export function GET() {
  const parts: string[] = [
    '# Motherbase — full documentation',
    '',
    `Source: ${SITE_URL}/docs — generated from content/docs, in sidebar order.`,
    'Open source, self-hosted backend platform. MIT licensed. TypeScript / Node.js.',
    '',
    'Callout tags below carry meaning: <Note> is context, <Warning> is a constraint that',
    'will bite you, and <Flag> is a known defect in the product itself.',
  ]

  for (const group of buildNav()) {
    parts.push('', '', `${'='.repeat(76)}`, `SECTION: ${group.label}`, `${'='.repeat(76)}`)
    for (const item of group.items) {
      const doc = getDocBySlug(item.slug)
      if (!doc) continue
      parts.push(
        '',
        `${'-'.repeat(76)}`,
        `# ${doc.frontmatter.title}`,
        `URL: ${SITE_URL}${item.href}`,
        doc.frontmatter.description ? `Summary: ${doc.frontmatter.description}` : '',
        `${'-'.repeat(76)}`,
        '',
        doc.rawContent.trim(),
      )
    }
  }

  return new Response(parts.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
