import { describe, expect, it } from 'vitest';
import { patchCellInPage } from '@/features/tables/lib/table-editor';

const page = (rows: Record<string, unknown>[]) => ({ rows, total: rows.length });

// Runs on every in-place cell edit, against every cached page of the table.
describe('patchCellInPage', () => {
  it('replaces the one cell of the matching row', () => {
    const after = patchCellInPage(page([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]), '2', 'id', 'name', 'z');
    expect(after.rows).toEqual([{ id: 1, name: 'a' }, { id: 2, name: 'z' }]);
  });

  it('returns the identical object when the row is on another page', () => {
    const before = page([{ id: 1, name: 'a' }]);
    expect(patchCellInPage(before, '9', 'id', 'name', 'z')).toBe(before);
  });
});
