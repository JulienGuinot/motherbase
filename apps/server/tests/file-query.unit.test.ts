import { describe, expect, it } from 'vitest';
import { buildFileWhere, filePage, parseFileFilters, MAX_FILE_PAGE_SIZE } from '../services/storage/file-query';

/** Flatten the AND chain so a clause can be looked for without its position. */
function clauses(where: ReturnType<typeof buildFileWhere>): unknown[] {
  return (where.AND as unknown[]) ?? [];
}

describe('buildFileWhere', () => {
  it('always scopes to ready files and keeps the caller base clause', () => {
    const where = buildFileWhere({ bucketId: 'b1' }, {});
    expect(clauses(where)).toContainEqual({ bucketId: 'b1' });
    expect(JSON.stringify(where)).toContain('ready');
  });

  it('searches key, bucket and owner email', () => {
    // These are the three fields the console's own search box matched when it
    // was filtering the fetched page. Applying them here is what makes an older
    // file findable at all.
    const json = JSON.stringify(buildFileWhere({}, { q: ' logo ' }));
    expect(json).toContain('"key"');
    expect(json).toContain('"bucket"');
    expect(json).toContain('"owner"');
    // Trimmed, so a stray space is not part of the search term.
    expect(json).toContain('"logo"');
  });

  it('turns a category into mime predicates', () => {
    expect(JSON.stringify(buildFileWhere({}, { category: 'image' }))).toContain('image/');
    expect(JSON.stringify(buildFileWhere({}, { category: 'archive' }))).toContain('zip');
  });

  it('builds "other" as the negation of every known category', () => {
    const json = JSON.stringify(buildFileWhere({}, { category: 'other' }));
    expect(json).toContain('NOT');
    expect(json).toContain('image/');
  });

  it('adds nothing for the "all" selections', () => {
    const plain = clauses(buildFileWhere({}, {}));
    const all = clauses(buildFileWhere({}, { category: 'all', visibility: 'all', q: '   ' }));
    expect(all).toHaveLength(plain.length);
  });

  it('filters on visibility', () => {
    expect(clauses(buildFileWhere({}, { visibility: 'private' }))).toContainEqual({ visibility: 'private' });
  });
});

describe('filePage', () => {
  it('defaults to the first page', () => {
    expect(filePage({})).toEqual({ page: 1, take: 25, skip: 0 });
  });

  it('computes the offset from the page', () => {
    expect(filePage({ page: 3, pageSize: 50 })).toEqual({ page: 3, take: 50, skip: 100 });
  });

  it('clamps nonsense rather than sending it to the database', () => {
    expect(filePage({ page: 0, pageSize: 0 }).page).toBe(1);
    expect(filePage({ pageSize: 10_000 }).take).toBe(MAX_FILE_PAGE_SIZE);
    expect(filePage({ page: -5 }).skip).toBe(0);
  });
});

describe('parseFileFilters', () => {
  it('reads a listing query string', () => {
    expect(parseFileFilters({ page: '2', pageSize: '50', q: ' logo ', category: 'image', visibility: 'private' }))
      .toEqual({ page: 2, pageSize: 50, q: 'logo', category: 'image', visibility: 'private' });
  });

  it('leaves absent and blank values undefined', () => {
    expect(parseFileFilters({ q: '   ' }).q).toBeUndefined();
    expect(parseFileFilters({}).page).toBeUndefined();
  });
});
