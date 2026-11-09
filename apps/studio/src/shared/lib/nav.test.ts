import { describe, it, expect } from 'vitest';
import { PRODUCTS, resolveProduct, stripProjectPrefix, segmentLabel, linkTo, flatNav } from '@/shared/lib/nav';

describe('nav taxonomy', () => {
  it('exposes every product with a unique key and base', () => {
    const keys = PRODUCTS.map(p => p.key);
    const bases = PRODUCTS.map(p => p.base);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(bases).size).toBe(bases.length);
  });

  // Products listed here render a contextual panel next to the icon rail; every
  // other product is single-page. Adding a panel is a deliberate nav change, so
  // this list is asserted exhaustively rather than by membership.
  it('only Database, Auth, Integrations and Observability carry a static panel', () => {
    const withPanel = PRODUCTS.filter(p => p.panel).map(p => p.key).sort();
    expect(withPanel).toEqual(['auth', 'database', 'integrations', 'observability']);
  });
});

describe('stripProjectPrefix', () => {
  it('drops a leading /p/:id prefix', () => {
    expect(stripProjectPrefix('/p/abc123/database/functions')).toBe('/database/functions');
  });
  it('leaves non-project paths untouched', () => {
    expect(stripProjectPrefix('/database/functions')).toBe('/database/functions');
  });
});

describe('resolveProduct', () => {
  it('resolves the product from a project-scoped path', () => {
    expect(resolveProduct('/p/abc/database/triggers')?.key).toBe('database');
  });
  it('resolves auth sub-pages to the auth product', () => {
    expect(resolveProduct('/p/abc/auth/policies')?.key).toBe('auth');
  });
  it('returns undefined for an unknown segment', () => {
    expect(resolveProduct('/p/abc/nonsense')).toBeUndefined();
  });
});

describe('segmentLabel', () => {
  it('labels a product base segment', () => {
    expect(segmentLabel('database')).toBe('Database');
  });
  it('labels a panel sub-segment', () => {
    expect(segmentLabel('policies')).toBe('Policies');
  });
  it('prefers the panel item of the parent product over a same-named product', () => {
    expect(segmentLabel('tables')).toBe('Table Editor');
    expect(segmentLabel('tables', 'database')).toBe('Tables');
    expect(segmentLabel('database', 'observability')).toBe('Query Performance');
  });
  it('falls back to the raw segment when unknown', () => {
    expect(segmentLabel('xyz')).toBe('xyz');
  });
});

describe('linkTo', () => {
  it('builds a product-scoped deep link', () => {
    expect(linkTo('database', 'functions')).toBe('/database/functions');
  });
  it('returns the base when no sub is given', () => {
    expect(linkTo('auth')).toBe('/auth');
  });
  it('falls back to overview for an unknown product', () => {
    expect(linkTo('bogus')).toBe('/overview');
  });
});

describe('flatNav', () => {
  it('includes products and their panel items with prefixed labels', () => {
    const entries = flatNav();
    expect(entries.find(e => e.path === '/database/functions')?.label).toBe('Database · Functions');
    expect(entries.find(e => e.path === '/auth/policies')?.label).toBe('Authentication · Policies');
  });
  it('does not emit empty index panel items as separate entries', () => {
    const entries = flatNav();
    expect(entries.filter(e => e.path === '/auth/').length).toBe(0);
  });
});
