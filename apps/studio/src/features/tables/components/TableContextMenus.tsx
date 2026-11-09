import { Clipboard, Code2, Copy, Edit2, ShieldCheck, Trash2 } from 'lucide-react';
import { ContextMenu } from '@/shared/ui/ContextMenu';
import type { TableMeta } from '@/features/tables/components/table.types';

interface MenuState<T> {
  x: number;
  y: number;
  data: T;
}

interface TableContextMenusProps {
  rowMenu: MenuState<Record<string, unknown>> | null;
  tableMenu: MenuState<TableMeta> | null;
  meta: TableMeta | undefined;
  readOnly: boolean;
  onCloseRowMenu: () => void;
  onCloseTableMenu: () => void;
  onEditRow: (row: Record<string, unknown>) => void;
  onDeleteRow: (row: Record<string, unknown>) => void;
  onOpenTable: (table: TableMeta) => void;
  onOpenTableSql: (table: TableMeta) => void;
  onOpenPermissions: (table: TableMeta) => void;
  onDeleteTable: (table: TableMeta) => void;
  onCopied: (title: string) => void;
}

export function TableContextMenus({
  rowMenu,
  tableMenu,
  meta,
  readOnly,
  onCloseRowMenu,
  onCloseTableMenu,
  onEditRow,
  onDeleteRow,
  onOpenTable,
  onOpenTableSql,
  onOpenPermissions,
  onDeleteTable,
  onCopied,
}: TableContextMenusProps) {
  return (
    <>
      {rowMenu && meta && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={onCloseRowMenu}
          items={[
            ...(readOnly ? [] : [{ label: 'Edit row', icon: <Edit2 size={13} />, action: () => onEditRow(rowMenu.data) }]),
            {
              label: 'Copy row as JSON',
              icon: <Clipboard size={13} />,
              action: () => {
                navigator.clipboard.writeText(JSON.stringify(rowMenu.data, null, 2));
                onCopied('Copied as JSON');
              },
            },
            {
              label: `Copy ${meta.primaryKey}`,
              icon: <Copy size={13} />,
              action: () => {
                navigator.clipboard.writeText(String(rowMenu.data[meta.primaryKey]));
                onCopied('Copied');
              },
            },
            ...(readOnly ? [] : [
              { type: 'separator' as const },
              { label: 'Delete row', danger: true, icon: <Trash2 size={13} />, action: () => onDeleteRow(rowMenu.data) },
            ]),
          ]}
        />
      )}

      {tableMenu && (
        <ContextMenu
          x={tableMenu.x}
          y={tableMenu.y}
          onClose={onCloseTableMenu}
          items={[
            { label: 'Open table', action: () => onOpenTable(tableMenu.data) },
            { label: 'Open in SQL editor', icon: <Code2 size={13} />, action: () => onOpenTableSql(tableMenu.data) },
            { label: 'Permissions', icon: <ShieldCheck size={13} />, action: () => onOpenPermissions(tableMenu.data) },
            ...(readOnly ? [] : [
              { type: 'separator' as const },
              { label: 'Delete table', danger: true, icon: <Trash2 size={13} />, action: () => onDeleteTable(tableMenu.data) },
            ]),
          ]}
        />
      )}
    </>
  );
}
