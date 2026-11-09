import { useQuery } from '@tanstack/react-query';
import { keepPreviousFor } from '@/shared/lib/query';
import { tablesApi } from '@/features/tables/api/tables.api';
import type { TabId, TableMeta } from '@/features/tables/components/table.types';
import { serializeFilters, type RowFilter } from '@/features/tables/lib/filters';

export function useTables() {
  return useQuery({
    queryKey: ['tables'],
    queryFn: tablesApi.tables,
  });
}

export function useTableRows(args: {
  active: string | undefined;
  tab: TabId;
  page: number;
  pageSize: number;
  sort: string | null;
  order: 'asc' | 'desc';
  filters: RowFilter[];
}) {
  const { active, tab, page, pageSize, sort, order, filters } = args;
  const filterParam = serializeFilters(filters);
  return useQuery({
    // Hold the current page of rows while a *new page, sort or filter of the
    // same table* loads, so paging does not blink through an empty grid, and
    // never across a table change: the headers come from table metadata, which
    // switches on click while the rows are still the previous table's. See
    // `shared/lib/query`, which this case is the reason for.
    placeholderData: keepPreviousFor(active),
    queryKey: ['rows', active, page, pageSize, sort, order, filterParam],
    enabled: Boolean(active) && tab === 'data',
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      if (sort) {
        params.set('sort', sort);
        params.set('order', order);
      }
      if (filterParam) params.set('filters', filterParam);
      return tablesApi.rows(active!, params);
    },
  });
}

export function useTableSchema(schema: string, meta: TableMeta | undefined) {
  return useQuery({
    queryKey: ['schema', schema, meta?.dbName],
    enabled: Boolean(meta?.dbName),
    queryFn: async () => {
      const all = await tablesApi.schemaTables(schema);
      return all.find(t => t.name === meta?.dbName) ?? null;
    },
    staleTime: 10_000,
  });
}

export function useTableIndexes(schema: string, meta: TableMeta | undefined, tab: TabId) {
  return useQuery({
    queryKey: ['indexes', schema, meta?.dbName],
    enabled: Boolean(meta?.dbName) && tab === 'indexes',
    queryFn: () => tablesApi.indexes(meta!.dbName, schema),
  });
}

export function useSchemaGraph(schema: string, tab: TabId) {
  return useQuery({
    queryKey: ['schema-graph', schema],
    // Loaded for the graph tab and to render foreign-key cell links in the data grid.
    enabled: tab === 'graph' || tab === 'data',
    queryFn: () => tablesApi.graph(schema),
    staleTime: 30_000,
  });
}
