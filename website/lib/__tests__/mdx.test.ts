import { describe, it, expect } from 'vitest'
import { getAllDocSlugs, getDocBySlug } from '../mdx'

describe('getAllDocSlugs', () => {
  it('returns at least one slug', () => {
    const slugs = getAllDocSlugs()
    expect(slugs.length).toBeGreaterThan(0)
  })

  it('returns arrays of strings', () => {
    const slugs = getAllDocSlugs()
    for (const slug of slugs) {
      expect(Array.isArray(slug)).toBe(true)
      expect(slug.every(s => typeof s === 'string')).toBe(true)
    }
  })

  it('includes getting-started/overview', () => {
    const slugs = getAllDocSlugs()
    expect(slugs).toContainEqual(['getting-started', 'overview'])
  })
})

describe('getDocBySlug', () => {
  it('returns null for missing slug', () => {
    expect(getDocBySlug(['does-not-exist', 'nope'])).toBeNull()
  })

  it('returns frontmatter and rawContent for existing file', () => {
    const doc = getDocBySlug(['getting-started', 'overview'])
    expect(doc).not.toBeNull()
    expect(doc!.frontmatter.title).toBe('Overview')
    expect(doc!.frontmatter.description).toBe('What is Motherbase and why does it exist?')
    expect(typeof doc!.rawContent).toBe('string')
    expect(doc!.rawContent.length).toBeGreaterThan(0)
  })
})
