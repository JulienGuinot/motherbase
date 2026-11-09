import { describe, it, expect } from 'vitest'
import { buildNav } from '../nav'

describe('buildNav', () => {
  it('returns only non-empty groups', () => {
    const nav = buildNav()
    expect(nav.length).toBeGreaterThanOrEqual(5)
    expect(nav.every(group => group.items.length > 0)).toBe(true)
  })

  it('orders items by frontmatter order', () => {
    const nav = buildNav()
    const platform = nav.find(group => group.dir === 'platform')
    expect(platform?.items[0].href).toBe('/docs/platform/auth')
  })

  it('first group is Getting Started', () => {
    const nav = buildNav()
    expect(nav[0].label).toBe('Getting Started')
  })

  it('Getting Started group has items', () => {
    const nav = buildNav()
    expect(nav[0].items.length).toBeGreaterThan(0)
  })

  it('each item has title, href, slug', () => {
    const nav = buildNav()
    for (const group of nav) {
      for (const item of group.items) {
        expect(typeof item.title).toBe('string')
        expect(item.href.startsWith('/docs/')).toBe(true)
        expect(Array.isArray(item.slug)).toBe(true)
      }
    }
  })

  it('overview item href is /docs/getting-started/overview', () => {
    const nav = buildNav()
    const overview = nav[0].items.find(i => i.slug[1] === 'overview')
    expect(overview?.href).toBe('/docs/getting-started/overview')
  })

  it('includes the updates guide in Getting Started', () => {
    const nav = buildNav()
    const gettingStarted = nav.find(group => group.dir === 'getting-started')
    const hrefs = gettingStarted?.items.map(item => item.href) ?? []

    expect(hrefs).toContain('/docs/getting-started/updates')
  })

  it('includes trigger and cron platform pages', () => {
    const nav = buildNav()
    const platform = nav.find(group => group.dir === 'platform')
    const hrefs = platform?.items.map(item => item.href) ?? []

    expect(hrefs).toContain('/docs/platform/triggers')
    expect(hrefs).toContain('/docs/platform/cron-jobs')
  })

  it('includes CLI docs pages', () => {
    const nav = buildNav()
    const cli = nav.find(group => group.dir === 'cli')
    const hrefs = cli?.items.map(item => item.href) ?? []

    expect(hrefs).toEqual([
      '/docs/cli/overview',
      '/docs/cli/getting-started',
      '/docs/cli/commands',
    ])
  })
})
