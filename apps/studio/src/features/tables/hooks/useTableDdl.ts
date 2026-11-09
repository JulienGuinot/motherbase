'use client';

import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { projectPath } from '@/shared/lib/project';
import { tablesApi } from '@/features/tables/api/tables.api';
import type { TableMeta } from '@/features/tables/components/table.types';

/** Every destructive DDL confirms first: none of it can be undone. */
export function useTableDdl({
  schema,
  meta,
  refreshSchema,
  refreshIndexes,
  notify,
  fail,
}: {
  schema: string;
  meta: TableMeta | undefined;
  refreshSchema: () => void;
  refreshIndexes: () => void;
  notify: (title: string) => void;
  fail: (title: string) => (error: unknown) => void;
}) {
  const router = useRouter();
  const qc = useQueryClient();

  const dropColumn = async (column: { name: string }) => {
    if (!(await confirmDialog({ title: `Drop column "${column.name}"?`, description: `The column and every value in it are removed from ${meta!.dbName}.`, confirmLabel: 'Drop column', tone: 'danger', typeToConfirm: column.name }))) return;
    await tablesApi.dropColumn(meta!.dbName, column.name, schema);
    refreshSchema();
    notify('Column dropped');
  };

  const dropIndex = async (index: { name: string }) => {
    if (!(await confirmDialog({ title: `Drop index "${index.name}"?`, description: 'Queries relying on it fall back to a sequential scan.', confirmLabel: 'Drop index', tone: 'danger' }))) return;
    await tablesApi.dropIndex(index.name, schema);
    refreshIndexes();
    notify('Index dropped');
  };

  const dropTable = async (table: TableMeta) => {
    if (!(await confirmDialog({ title: `Drop table "${table.dbName}"?`, description: 'The table, its rows, indexes and policies are all removed.', confirmLabel: 'Drop table', tone: 'danger', typeToConfirm: table.dbName }))) return;
    try {
      await tablesApi.dropTable(table.dbName, schema);
      for (const key of ['tables', 'stats', 'rows']) qc.invalidateQueries({ queryKey: [key] });
      if (meta?.model === table.model) router.push(projectPath('/tables'));
      notify('Table dropped');
    } catch (error) {
      fail('Drop failed')(error);
    }
  };

  return { dropColumn, dropIndex, dropTable };
}
