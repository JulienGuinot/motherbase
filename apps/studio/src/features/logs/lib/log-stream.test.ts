import { describe, expect, it } from 'vitest';
import { countByLevel, entriesSince, facetOptions, filterEntries } from '@/features/logs/lib/log-stream';

const of = (entry: { source: string }) => entry.source;
const rows = (...sources: string[]) => sources.map(source => ({ source }));

describe('facetOptions with a fixed domain', () => {
  it('keeps the domain order and count regardless of what is present', () => {
    // 'auth' precedes 'http' in the domain even though http is far more frequent.
    const domain = ['auth', 'http', 'sql'];
    const options = facetOptions(rows('http', 'http', 'http', 'auth'), of, domain);
    expect(options.map(o => o.value)).toEqual(['auth', 'http', 'sql']);
    expect(options).toEqual([
      { value: 'auth', count: 1 },
      { value: 'http', count: 3 },
      { value: 'sql', count: 0 }, // absent, still shown at zero — the list must not shrink
    ]);
  });

  it('does not reshuffle when the traffic mix changes', () => {
    const domain = ['auth', 'http', 'sql'];
    const first = facetOptions(rows('http', 'http', 'auth'), of, domain).map(o => o.value);
    const second = facetOptions(rows('sql', 'sql', 'sql', 'auth'), of, domain).map(o => o.value);
    expect(first).toEqual(second);
  });

  it('appends an unexpected value after the domain so it is never hidden', () => {
    const options = facetOptions(rows('http', 'cron', 'cron'), of, ['http', 'sql']);
    expect(options).toEqual([
      { value: 'http', count: 1 },
      { value: 'sql', count: 0 },
      { value: 'cron', count: 2 },
    ]);
  });
});

describe('facetOptions without a domain', () => {
  it('is just the observed values, most frequent first', () => {
    const options = facetOptions(rows('a', 'b', 'b', 'c', 'c', 'c'), of);
    expect(options).toEqual([
      { value: 'c', count: 3 },
      { value: 'b', count: 2 },
      { value: 'a', count: 1 },
    ]);
  });
});

describe('filterEntries', () => {
  const entry = (at: string, level: 'info' | 'warn' | 'error', source: string, message: string) =>
    ({ at, level, source, message });
  const entries = [
    entry('2026-10-01T10:00:00Z', 'info', 'http', 'GET /a'),
    entry('2026-10-01T10:01:00Z', 'error', 'sql', 'boom'),
    entry('2026-10-01T10:02:00Z', 'error', 'http', 'GET /b failed'),
  ];
  const sourceFacet = { key: 'source', label: 'Source', of: (e: { source: string }) => e.source };
  const criteria = {
    levels: new Set<string>(),
    facets: [sourceFacet],
    selected: {} as Record<string, Set<string>>,
    query: '',
    search: (e: { message: string }) => [e.message],
  };

  it('returns everything newest first when no filter is active', () => {
    expect(filterEntries(entries, criteria).map(e => e.message)).toEqual(['GET /b failed', 'boom', 'GET /a']);
  });

  it('applies level, facet and text filters together', () => {
    const result = filterEntries(entries, {
      ...criteria,
      levels: new Set(['error']),
      selected: { source: new Set(['http']) },
      query: ' FAILED ',
    });
    expect(result.map(e => e.message)).toEqual(['GET /b failed']);
  });

  it('ignores a facet whose selection is empty', () => {
    expect(filterEntries(entries, { ...criteria, selected: { source: new Set() } })).toHaveLength(3);
  });
});

describe('entriesSince', () => {
  it('keeps entries at or after the cutoff, and any it cannot date', () => {
    const rows = [
      { at: '2026-10-01T09:59:59Z', level: 'info' as const, source: 'http', message: 'old' },
      { at: '2026-10-01T10:00:00Z', level: 'info' as const, source: 'http', message: 'edge' },
      { at: 'not a date', level: 'info' as const, source: 'http', message: 'undated' },
    ];
    expect(entriesSince(rows, Date.parse('2026-10-01T10:00:00Z')).map(r => r.message)).toEqual(['edge', 'undated']);
  });
});

describe('countByLevel', () => {
  it('counts each level in one pass', () => {
    const rows = ['info', 'error', 'error', 'warn'].map(level => ({ at: '', level: level as 'info' | 'warn' | 'error', source: '', message: '' }));
    expect(countByLevel(rows)).toEqual({ info: 1, warn: 1, error: 2 });
  });
});
