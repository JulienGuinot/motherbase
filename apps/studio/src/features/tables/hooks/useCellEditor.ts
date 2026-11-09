import { useState } from 'react';
import type { FieldMeta } from '@/shared/ui/RowDrawer';
import { parseCell } from '@/features/tables/lib/parse-cell';

type Row = Record<string, unknown>;
type Move = 'down' | 'right' | 'left';

/**
 * One cell being edited in place, keyed by row index and column so a re-render
 * of the page does not put the caret back where it was two tables ago.
 */
export interface CellEdit { rowIndex: number; column: string; draft: string }

/**
 * In-place editing of the grid's cells. Enter walks down the column and Tab
 * along the row, the way every spreadsheet and every other database client
 * behaves: entering ten values in a column should be ten keystrokes and ten
 * Enters, not ten double-clicks.
 *
 * Both stop at the edge rather than wrapping: wrapping from the last column
 * of one row into the first of the next is how you edit the wrong record.
 */
export function useCellEditor({
  rows,
  editableOrder,
  onUpdateCell,
}: {
  rows: Row[];
  /** Editable columns in display order: the path Tab walks along. */
  editableOrder: FieldMeta[];
  onUpdateCell: (row: Row, column: string, value: unknown) => void;
}) {
  const [edit, setEdit] = useState<CellEdit | null>(null);

  const open = (rowIndex: number, column: string) => {
    const value = rows[rowIndex]?.[column];
    setEdit({ rowIndex, column, draft: value == null ? '' : String(value) });
  };

  const nextCell = (rowIndex: number, column: string, move: Move) => {
    if (move === 'down') return rowIndex + 1 < rows.length ? { rowIndex: rowIndex + 1, column } : null;
    const at = editableOrder.findIndex(c => c.name === column);
    const target = editableOrder[at + (move === 'right' ? 1 : -1)];
    return target ? { rowIndex, column: target.name } : null;
  };

  const commit = (rowIndex: number, row: Row, column: FieldMeta, move?: Move) => {
    // Only the cell that currently holds the draft may commit it. Moving to the
    // next cell unmounts this input, and the blur that follows would otherwise
    // arrive with the *new* draft and write it into the old column.
    if (!edit || edit.rowIndex !== rowIndex || edit.column !== column.name) return;
    const value = parseCell(edit.draft, column.type);
    const target = move ? nextCell(rowIndex, column.name, move) : null;
    if (target) open(target.rowIndex, target.column);
    else setEdit(null);
    // Unchanged draft: skip the round trip rather than writing the same value.
    if (value === (row[column.name] ?? null)) return;
    onUpdateCell(row, column.name, value);
  };

  return {
    edit,
    isEditing: (rowIndex: number, column: string) => edit?.rowIndex === rowIndex && edit.column === column,
    open,
    setDraft: (draft: string) => setEdit(current => (current ? { ...current, draft } : current)),
    cancel: () => setEdit(null),
    commit,
  };
}
