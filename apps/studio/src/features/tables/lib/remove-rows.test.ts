import { describe, expect, it } from 'vitest';
import { removeRowsFromPage } from '@/features/tables/lib/table-editor';

const page = (rows: Record<string, unknown>[], total: number) => ({ rows, total, page: 1, pageSize: 50 });

// This runs on every optimistic delete, against every cached page of the table.
// Getting the total wrong makes the pager disagree with the grid; returning a
// new object for an untouched page re-renders pages nothing happened to.
describe('removeRowsFromPage', () => {
  it('drops the rows and decrements the total by what this page held', () => {
    const before = page([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 120);
    const after = removeRowsFromPage(before, new Set(['a', 'c']), 'id');
    expect(after.rows).toEqual([{ id: 'b' }]);
    expect(after.total).toBe(118);
  });

  it('only counts the ids this page actually held', () => {
    // 'z' lives on some other page; this page's total must not be docked for it.
    const after = removeRowsFromPage(page([{ id: 'a' }], 10), new Set(['a', 'z']), 'id');
    expect(after.total).toBe(9);
  });

  it('returns the identical object when nothing matched', () => {
    const before = page([{ id: 'a' }], 10);
    expect(removeRowsFromPage(before, new Set(['zzz']), 'id')).toBe(before);
  });

  it('compares keys as strings, so numeric primary keys match', () => {
    const after = removeRowsFromPage(page([{ id: 7 }, { id: 8 }], 2), new Set(['7']), 'id');
    expect(after.rows).toEqual([{ id: 8 }]);
  });

  it('never drives the total below zero', () => {
    // A stale cached page can claim more rows than the total the server last
    // reported; the pager must not be handed a negative.
    const after = removeRowsFromPage(page([{ id: 'a' }, { id: 'b' }], 1), new Set(['a', 'b']), 'id');
    expect(after.total).toBe(0);
  });
});
