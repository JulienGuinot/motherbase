import type { MouseEvent } from 'react';
import { ArrowDown, ArrowUp, ChevronRight } from 'lucide-react';
import type { FieldMeta } from '@/shared/ui/RowDrawer';
import { CellValue } from '@/features/tables/components/CellValue';
import { cellTitle } from '@/features/tables/components/table.utils';
import type { TableMeta } from '@/features/tables/components/table.types';
import type { useCellEditor } from '@/features/tables/hooks/useCellEditor';

type Row = Record<string, unknown>;
type CellEditor = ReturnType<typeof useCellEditor>;

const GUTTER_WIDTH = 34;

const stickyClass = (columnIndex: number) => (columnIndex === 0 ? 'sticky-col sticky-col-last' : '');

function SortableHeader({ column, sort, order, onSort }: { column: FieldMeta; sort: string | null; order: 'asc' | 'desc'; onSort: (column: string) => void }) {
  const active = sort === column.name;
  return (
    // The wrapper is what carries `resize: horizontal`; the browser draws and
    // drives the grab handle, so there is no drag state, no pointer capture and
    // no width bookkeeping to get wrong.
    <div className="resizable">
      <button onClick={() => onSort(column.name)} className="flex items-center gap-1.5 hover:text-current" style={{ color: active ? 'var(--accent)' : undefined }}>
        {column.name}<span className="mono text-[8px] opacity-50">{column.type}</span>
        {active && (order === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
      </button>
    </div>
  );
}

function EditingCell({ editor, rowIndex, row, column, columnIndex, left }: { editor: CellEditor; rowIndex: number; row: Row; column: FieldMeta; columnIndex: number; left: number | undefined }) {
  return (
    <td className={`max-w-xs ${stickyClass(columnIndex)}`} style={{ padding: 2, left }}>
      <input
        autoFocus
        className="input"
        style={{ fontSize: 12, padding: '4px 6px' }}
        value={editor.edit?.draft ?? ''}
        placeholder="empty = NULL"
        onChange={event => editor.setDraft(event.target.value)}
        onBlur={() => editor.commit(rowIndex, row, column)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            editor.commit(rowIndex, row, column, 'down');
          } else if (event.key === 'Tab') {
            // Taking Tab over is the point: the browser would otherwise move
            // focus to the row's Edit button.
            event.preventDefault();
            editor.commit(rowIndex, row, column, event.shiftKey ? 'left' : 'right');
          } else if (event.key === 'Escape') {
            editor.cancel();
          }
        }}
      />
    </td>
  );
}

function ValueCell({
  value,
  column,
  columnIndex,
  left,
  writable,
  foreignTable,
  foreignModel,
  onEdit,
  onOpenForeignTable,
}: {
  value: unknown;
  column: FieldMeta;
  columnIndex: number;
  left: number | undefined;
  writable: boolean;
  foreignTable: string | undefined;
  foreignModel: string | undefined;
  onEdit: () => void;
  onOpenForeignTable: (model: string) => void;
}) {
  const linkable = Boolean(foreignModel) && value != null && value !== '';
  return (
    <td
      className={`max-w-xs truncate ${writable ? 'cursor-text' : ''} ${stickyClass(columnIndex)}`}
      style={{ left }}
      title={writable ? `${cellTitle(value)}. Double-click to edit` : cellTitle(value)}
      onDoubleClick={() => writable && onEdit()}
    >
      {linkable ? (
        <button onClick={() => onOpenForeignTable(foreignModel!)} className="inline-flex items-center gap-1 hover:underline" style={{ color: 'var(--accent)' }} title={`Open ${foreignTable}`}>
          <CellValue value={value} type={column.type} /><ChevronRight size={11} />
        </button>
      ) : <CellValue value={value} type={column.type} />}
    </td>
  );
}

export function DataGrid({
  meta,
  rows,
  columns,
  editableColumns,
  selectable,
  readOnly,
  selected,
  sort,
  order,
  editor,
  foreignTableByColumn,
  modelByTable,
  onSort,
  onToggleSelected,
  onToggleSelectAll,
  onRowClick,
  onRowContextMenu,
  onOpenForeignTable,
}: {
  meta: TableMeta | undefined;
  rows: Row[];
  columns: FieldMeta[];
  editableColumns: Set<string>;
  selectable: boolean;
  readOnly: boolean;
  selected: string[];
  sort: string | null;
  order: 'asc' | 'desc';
  editor: CellEditor;
  foreignTableByColumn: Record<string, string>;
  modelByTable: Record<string, string>;
  onSort: (column: string) => void;
  onToggleSelected: (key: unknown) => void;
  onToggleSelectAll: () => void;
  onRowClick: (row: Row) => void;
  onRowContextMenu: (event: MouseEvent, row: Row) => void;
  onOpenForeignTable: (model: string) => void;
}) {
  // The checkbox gutter and the first visible column stay put while the rest
  // scrolls, so a row is still identifiable forty columns to the right.
  const gutter = selectable ? GUTTER_WIDTH : 0;
  const stickyAt = (index: number) => (index === 0 ? gutter : undefined);
  const allChecked = rows.length > 0 && selected.length === rows.length;

  return (
    <table className="console" style={{ width: 'max-content', minWidth: '100%' }}>
      <thead><tr>
        {selectable && (
          <th className="sticky-col" style={{ width: gutter, left: 0 }}>
            <input type="checkbox" checked={allChecked} onChange={onToggleSelectAll} aria-label="Select every loaded row" style={{ accentColor: 'var(--accent)' }} />
          </th>
        )}
        {columns.map((column, columnIndex) => (
          <th key={column.name} className={stickyClass(columnIndex) || undefined} style={columnIndex === 0 ? { left: gutter } : undefined}>
            <SortableHeader column={column} sort={sort} order={order} onSort={onSort} />
          </th>
        ))}
        {!readOnly && <th aria-label="Row actions" />}
      </tr></thead>
      <tbody>{rows.map((row, rowIndex) => {
        const key = meta ? String(row[meta.primaryKey]) : String(rowIndex);
        const checked = selected.includes(key);
        return (
          <tr
            key={rowIndex}
            className="row-host"
            onContextMenu={event => onRowContextMenu(event, row)}
            // An attribute, not an inline background: the frozen cells need
            // to paint the selected colour themselves, and a CSS rule can
            // reach them from the row while an inline style cannot.
            data-checked={checked}
          >
            {selectable && (
              <td className="sticky-col" style={{ left: 0 }} onClick={event => event.stopPropagation()}>
                <input type="checkbox" checked={checked} onChange={() => onToggleSelected(row[meta!.primaryKey])} aria-label={`Select row ${key}`} style={{ accentColor: 'var(--accent)' }} />
              </td>
            )}
            {columns.map((column, columnIndex) => {
              if (editor.isEditing(rowIndex, column.name)) {
                return <EditingCell key={column.name} editor={editor} rowIndex={rowIndex} row={row} column={column} columnIndex={columnIndex} left={stickyAt(columnIndex)} />;
              }
              const foreignTable = foreignTableByColumn[column.name];
              return (
                <ValueCell
                  key={column.name}
                  value={row[column.name]}
                  column={column}
                  columnIndex={columnIndex}
                  left={stickyAt(columnIndex)}
                  // The pk and any generated column stay read-only: writing them
                  // from the grid would move the row out from under the request.
                  writable={selectable && editableColumns.has(column.name)}
                  foreignTable={foreignTable}
                  foreignModel={foreignTable ? modelByTable[foreignTable] : undefined}
                  onEdit={() => editor.open(rowIndex, column.name)}
                  onOpenForeignTable={onOpenForeignTable}
                />
              );
            })}
            {/* Row clicks belong to the cell editor, so the full-row editor is
                one explicit button per row. */}
            {!readOnly && (
              <td className="row-actions text-right">
                <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => onRowClick(row)}>
                  Edit row
                </button>
              </td>
            )}
          </tr>
        );
      })}</tbody>
    </table>
  );
}
