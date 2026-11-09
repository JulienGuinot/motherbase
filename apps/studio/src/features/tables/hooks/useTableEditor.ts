'use client';

import { useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import type { SchemaTable } from '@/shared/types/schema';
import { projectPath } from '@/shared/lib/project';
import { useActiveTable } from '@/features/tables/hooks/useActiveTable';
import { useRowBrowser } from '@/features/tables/hooks/useRowBrowser';
import { useRowWrites } from '@/features/tables/hooks/useRowWrites';
import { useTableDdl } from '@/features/tables/hooks/useTableDdl';
import { useSchemaGraph, useTableIndexes, useTableSchema } from '@/features/tables/hooks/useTables';
import { isTab, selectAllSql, TABS, type TabId } from '@/features/tables/lib/table-editor';
import type { TableMeta } from '@/features/tables/components/table.types';

/**
 * Everything the table editor browses and writes: the active table, the row
 * query parameters, the schema side queries, and the DDL each panel can run.
 *
 * The active tab lives in the URL so a table view can be linked to, and the
 * browse state resets whenever the table changes.
 */
export function useTableEditor() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();

  const [editingColumn, setEditingColumn] = useState<SchemaTable['columns'][number] | null>(null);
  const [newTableOpen, setNewTableOpen] = useState(false);

  const requestedTab = searchParams.get('tab');
  const tab: TabId = isTab(requestedTab) ? requestedTab : 'data';

  const table = useActiveTable();
  const { schema, meta, active } = table;
  const columns = useMemo(() => meta?.fields?.filter(field => !field.sensitive) ?? [], [meta?.fields]);
  const browser = useRowBrowser(active, tab, columns);
  const schemaQuery = useTableSchema(schema, meta);
  const indexesQuery = useTableIndexes(schema, meta, tab);
  const graphQuery = useSchemaGraph(schema, tab);

  const notify = (title: string, message?: string) => toast.push({ kind: 'success', title, message });
  const fail = (title: string) => (error: unknown) =>
    toast.push({ kind: 'error', title, message: getErrorMessage(error) });

  const writes = useRowWrites({ meta, rows: browser.rows, notify, fail });

  const refreshSchema = () => {
    schemaQuery.refetch();
    qc.invalidateQueries({ queryKey: ['tables'] });
    writes.refreshRows();
  };

  const ddl = useTableDdl({ schema, meta, refreshSchema, refreshIndexes: () => indexesQuery.refetch(), notify, fail });

  /** Column name to referenced table (dbName), for the active table. */
  const foreignTableByColumn = useMemo(() => {
    const map: Record<string, string> = {};
    if (!meta?.dbName) return map;
    for (const edge of graphQuery.data?.edges ?? []) {
      if (edge.fromTable === meta.dbName) map[edge.fromColumn] = edge.toTable;
    }
    return map;
  }, [graphQuery.data, meta]);

  const openTable = (nextModel: string, keepQuery = false) => {
    const query = keepQuery ? searchParams.toString() : '';
    router.push(projectPath(`/tables/${nextModel}${query ? `?${query}` : ''}`));
    browser.reset();
  };

  const openSqlFor = (dbName: string) =>
    router.push(projectPath(`/sql?q=${encodeURIComponent(selectAllSql(dbName))}`));

  const selectTab = (nextTab: TabId) => {
    const next = new URLSearchParams(searchParams.toString());
    if (nextTab === 'data') next.delete('tab');
    else next.set('tab', nextTab);
    const query = next.toString();
    // replace, not push: switching tabs is not a step to walk back through.
    router.replace(`${pathname}${query ? `?${query}` : ''}`);
  };

  return {
    ...table,
    ...browser,
    ...writes,
    ...ddl,
    tabs: TABS,
    tab,
    selectTab,
    openTable,
    columns,
    foreignTableByColumn,
    schemaQuery,
    indexesQuery,
    graphQuery,
    refreshSchema,
    editingColumn,
    setEditingColumn,
    newTableOpen,
    setNewTableOpen,
    openSqlForActive: () => openSqlFor(meta!.dbName),
    openSqlForTable: (target: TableMeta) => openSqlFor(target.dbName),
    openPermissions: (target: TableMeta) => router.push(projectPath(`/tables/${target.model}?tab=policies`)),
    notify: (title: string) => notify(title),
  };
}
