import { describe, expect, it } from 'vitest'
import { SITE_URL, REPO_URL } from '../site'
import site from '../site.json'

// The bug this guards: lib/site.ts used to *claim* it shared its fallback with
// next-sitemap.config.js while both held their own string literal, free to
// drift apart — which would have shipped a sitemap disagreeing with llms.txt
// about the canonical origin.
describe('site constants', () => {
  it('gives next-sitemap and the app the same origin fallback', async () => {
    delete process.env.SITE_URL
    const config = (await import('../../next-sitemap.config.js')).default as { siteUrl: string }
    expect(config.siteUrl).toBe(site.url)
    expect(SITE_URL).toBe(site.url)
  })

  it('carries no trailing slash, so joined paths never double up', () => {
    // llms.txt builds links as `${SITE_URL}${item.href}` with href already
    // leading with '/'.
    expect(SITE_URL.endsWith('/')).toBe(false)
  })

  it('exposes the repository URL as an absolute github link', () => {
    expect(REPO_URL).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+$/)
  })
})
