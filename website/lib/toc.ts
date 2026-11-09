import GithubSlugger from 'github-slugger'

export interface TocItem {
  id: string
  text: string
  level: 2 | 3
}

/**
 * Strip the inline markdown that MDX would have consumed before `rehype-slug`
 * ever sees the heading — it slugs the rendered *text*, not the source.
 */
function stripInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [label](href) / ![alt](src)
    .replace(/([*_`~]+)(.+?)\1/g, '$2') // `code`, **bold**, _em_, ~~del~~
    .trim()
}

/**
 * Build the table of contents from raw MDX. Ids must match the ones
 * `rehype-slug` puts in the HTML, so they come from github-slugger itself —
 * one instance per document, because it is also the duplicate-heading counter.
 */
export function extractToc(rawContent: string): TocItem[] {
  const slugger = new GithubSlugger()
  const items: TocItem[] = []
  let inFence = false

  for (const line of rawContent.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const match = line.match(/^(#{2,3}) +(.+)/)
    if (!match) continue

    const text = stripInline(match[2])
    items.push({ id: slugger.slug(text), text, level: match[1].length as 2 | 3 })
  }

  return items
}
