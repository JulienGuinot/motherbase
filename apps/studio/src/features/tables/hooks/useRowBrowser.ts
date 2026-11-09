'use client';

import { useMemo, useState } from 'react';
import { useDebounced } from '@/shared/hooks/useDebounced';
import { useTableRows } from '@/features/tables/hooks/useTables';
import type { RowFilter, TabId } from '@/features/tables/lib/table-editor';
import type { TableMeta } from '@/features/tables/components/table.types';

type Column = NonNullable<TableMeta['fields']>[number];

/** Paging, sorting, filtering and the in-page search of the rows grid. */
export function useRowBrowser(active: string | undefined, tab: TabId, columns: Column[]) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState<string | null>(null);
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [filters, setFilters] = useState<RowFilter[]>([]);

  // `filters` drives the filter bar; this drives the request, so typing in a
  // filter value does not send a SELECT and a COUNT(*) per keystroke.
  const queryFilters = useDebounced(filters, 300);
  const rowsQuery = useTableRows({ active, tab, page, pageSize, sort, order, filters: queryFilters });
  const total = rowsQuery.data?.total;

  const rows = useMemo(() => {
    const all = rowsQuery.data?.rows ?? [];
    const term = search.trim().toLowerCase();
    if (!term) return all;
    return all.filter(row => columns.some(col => String(row[col.name] ?? '').toLowerCase().includes(term)));
  }, [rowsQuery.data, search, columns]);

  return {
    rows,
    total,
    totalEstimated: rowsQuery.data?.estimated ?? false,
    rowsLoading: rowsQuery.isLoading,
    rowsLoaded: Boolean(rowsQuery.data),
    search,
    setSearch,
    filters,
    setFilters: (next: RowFilter[]) => {
      setFilters(next);
      setPage(1);
    },
    sort,
    order,
    toggleSort: (column: string) => {
      if (sort === column) setOrder(current => (current === 'asc' ? 'desc' : 'asc'));
      else {
        setSort(column);
        setOrder('asc');
      }
    },
    clearSort: () => setSort(null),
    page,
    setPage,
    pageSize,
    setPageSize: (size: number) => {
      setPageSize(size);
      setPage(1);
    },
    totalPages: Math.max(1, Math.ceil((total ?? 0) / pageSize)),
    /** Back to page one, unsorted and unfiltered: the state a newly opened table starts in. */
    reset: () => {
      setPage(1);
      setSort(null);
      setSearch('');
      setFilters([]);
    },
  };
}
