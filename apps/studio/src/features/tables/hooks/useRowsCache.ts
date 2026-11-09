'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { RowsPage } from '@/features/tables/api/tables.api';
import { patchCellInPage, removeRowsFromPage } from '@/features/tables/lib/table-editor';

/**
 * Optimistic writes to every cached page of one table's rows. Each write
 * returns its undo, so a failed request can put the cache back exactly as it
 * was. Every page is patched, not just the one on screen, so stepping back to
 * a cached page does not resurrect a deleted row.
 */
export function useRowsCache(model: string | undefined, primaryKey: string | undefined) {
  const qc = useQueryClient();
  const queryKey = ['rows', model];

  const writeAll = (transform: (page: RowsPage, key: string) => RowsPage): (() => void) => {
    if (!primaryKey) return () => {};
    const snapshot = qc.getQueriesData<RowsPage>({ queryKey });
    qc.setQueriesData<RowsPage>({ queryKey }, page => (page ? transform(page, primaryKey) : page));
    return () => {
      for (const [cacheKey, data] of snapshot) qc.setQueryData(cacheKey, data);
    };
  };

  return {
    invalidate: () => qc.invalidateQueries({ queryKey }),
    dropRows: (ids: Set<string>) => writeAll((page, key) => removeRowsFromPage(page, ids, key)),
    patchCell: (id: string, column: string, value: unknown) =>
      writeAll((page, key) => patchCellInPage(page, id, key, column, value)),
  };
}
