import { describe, it, expect } from 'vitest'
import GithubSlugger from 'github-slugger'
import { extractToc } from '../toc'

describe('extractToc', () => {
  it('produces the same ids rehype-slug does', () => {
    const source = [
      '## Pourquoi ?',
      '## `createClient()`',
      '## Setup',
      '## Setup',
    ].join('\n')

    // What rehype-slug would emit: github-slugger over the rendered heading text.
    const slugger = new GithubSlugger()
    const expected = ['Pourquoi ?', 'createClient()', 'Setup', 'Setup'].map(t => slugger.slug(t))

    expect(extractToc(source).map(i => i.id)).toEqual(expected)
    expect(expected[3]).toBe('setup-1') // the duplicate counter is live
  })

  it('ignores headings inside fenced code blocks', () => {
    const source = '## Real\n\n```bash\n## installation\n```\n\n### After'
    expect(extractToc(source)).toEqual([
      { id: 'real', text: 'Real', level: 2 },
      { id: 'after', text: 'After', level: 3 },
    ])
  })

  it('strips inline markdown from the displayed text', () => {
    expect(extractToc('## Le **client**')[0]).toEqual({ id: 'le-client', text: 'Le client', level: 2 })
  })
})
