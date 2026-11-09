'use client';

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { tablesApi } from '@/features/tables/api/tables.api';
import { useRowsCache } from '@/features/tables/hooks/useRowsCache';
import { rowId, rowsLabel } from '@/features/tables/lib/table-editor';
import type { TableMeta } from '@/features/tables/components/table.types';

type Row = Record<string, unknown>;

/**
 * Every row write of the editor: the drawer's save and delete, in-place cell
 * edits, single and bulk deletes, and the checked-rows selection they act on.
 *
 * Writes leave the grid at once rather than after the request and the refetch
 * behind it, which would read as a missed click or a rejected edit. Each one
 * restores the cache when the server refuses.
 */
export function useRowWrites({
  meta,
  rows,
  notify,
  fail,
}: {
  meta: TableMeta | undefined;
  rows: Row[];
  notify: (title: string, message?: string) => void;
  fail: (title: string) => (error: unknown) => void;
}) {
  const active = meta?.model;
  const rowsCache = useRowsCache(active, meta?.primaryKey);
  const invalidateRows = rowsCache.invalidate;
  const keyOf = (row: Row | null | undefined) => row?.[meta!.primaryKey];

  const [editing, setEditing] = useState<{ row: Row | null } | null>(null);
  /** Primary keys of the checked rows, as strings so mixed pk types compare. */
  const [selected, setSelected] = useState<string[]>([]);

  // A checked row that leaves the result set (page turn, new filter, other
  // table) must not stay checked, or the next bulk action deletes a row the
  // operator can no longer see. Derived rather than reset in an effect: there
  // is no state to keep in sync, only rows that are on screen and rows that
  // are not.
  const visibleSelected = useMemo(() => {
    if (!meta || selected.length === 0) return [];
    const onScreen = new Set(rows.map(row => String(row[meta.primaryKey])));
    return selected.filter(id => onScreen.has(id));
  }, [selected, rows, meta]);

  const save = useMutation({
    mutationFn: async (data: Row) => {
      const key = keyOf(editing?.row);
      return key != null ? tablesApi.updateRow(active!, rowId(key), data) : tablesApi.createRow(active!, data);
    },
    onSuccess: () => {
      invalidateRows();
      notify('Saved', `${active} updated`);
      setEditing(null);
    },
    onError: fail('Save failed'),
  });

  const updateCell = useMutation({
    mutationFn: ({ key, column, value }: { key: unknown; column: string; value: unknown }) =>
      tablesApi.updateRow(active!, rowId(key), { [column]: value }),
    onMutate: ({ key, column, value }) => ({ undo: rowsCache.patchCell(String(key), column, value) }),
    onError: (error, _vars, context) => {
      context?.undo();
      fail('Cell update failed')(error);
    },
    onSettled: invalidateRows,
  });

  const bulkDelete = useMutation({
    // ponytail: sequential DELETEs, one request per row. The admin API has no
    // delete-many route; add one if operators start clearing thousands of rows.
    mutationFn: async (keys: string[]) => {
      for (const key of keys) await tablesApi.deleteRow(active!, key);
      return keys.length;
    },
    onMutate: (keys: string[]) => {
      setSelected([]);
      return { undo: rowsCache.dropRows(new Set(keys)) };
    },
    onSuccess: count => notify(`${rowsLabel(count)} deleted`),
    // Partial failure is possible here: some DELETEs may already have landed.
    // Putting the whole selection back and refetching is the honest answer.
    // The refetch is what settles which rows actually survived.
    onError: (error, _keys, context) => {
      context?.undo();
      fail('Bulk delete failed')(error);
    },
    onSettled: invalidateRows,
  });

  const removeEditing = useMutation({
    mutationFn: async () => tablesApi.deleteRow(active!, rowId(keyOf(editing?.row))),
    onMutate: () => {
      const key = keyOf(editing?.row);
      setEditing(null);
      return { undo: rowsCache.dropRows(new Set([String(key)])) };
    },
    onSuccess: () => notify('Deleted', 'Row removed'),
    onError: (error, _vars, context) => {
      context?.undo();
      fail('Delete failed')(error);
    },
    onSettled: invalidateRows,
  });

  const deleteRow = async (row: Row) => {
    const key = keyOf(row);
    if (!(await confirmDialog({ title: 'Delete this row?', description: `${meta!.primaryKey} = ${String(key)}`, confirmLabel: 'Delete row', tone: 'danger' }))) return;
    // The row leaves the grid on confirm, not on response. Same contract as
    // the drawer and the bulk action.
    const undo = rowsCache.dropRows(new Set([String(key)]));
    try {
      await tablesApi.deleteRow(active!, rowId(key));
      notify('Row deleted');
    } catch (error) {
      undo();
      fail('Delete failed')(error);
    } finally {
      invalidateRows();
    }
  };

  const deleteSelected = async () => {
    const count = visibleSelected.length;
    if (!count) return;
    const ok = await confirmDialog({
      title: `Delete ${rowsLabel(count)}?`,
      description: `From ${meta!.dbName}. Rows are removed one by one and cannot be recovered.`,
      confirmLabel: `Delete ${rowsLabel(count)}`,
      tone: 'danger',
    });
    if (ok) bulkDelete.mutate(visibleSelected);
  };

  return {
    refreshRows: invalidateRows,
    selected: visibleSelected,
    toggleSelected: (key: unknown) => {
      const id = String(key);
      setSelected(current => (current.includes(id) ? current.filter(k => k !== id) : [...current, id]));
    },
    /** Header checkbox: select every row currently rendered, or clear. */
    toggleSelectAll: () =>
      setSelected(current => (current.length === rows.length ? [] : rows.map(row => String(keyOf(row))))),
    clearSelection: () => setSelected([]),
    bulkDeleting: bulkDelete.isPending,
    deleteSelected,
    updatingCell: updateCell.isPending,
    updateCell: (row: Row, column: string, value: unknown) => updateCell.mutate({ key: keyOf(row), column, value }),
    editing,
    setEditing,
    saving: save.isPending || removeEditing.isPending,
    saveRow: (data: Row) => save.mutate(data),
    deleteEditingRow: () => removeEditing.mutate(),
    deleteRow,
  };
}
