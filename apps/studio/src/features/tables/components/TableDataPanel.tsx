import { useMemo, useState, type MouseEvent } from 'react';
import { Plus } from 'lucide-react';
import { useProjectPersistentState } from '@/shared/hooks/usePersistentState';
import { FilterEditor } from '@/features/tables/components/FilterBar';
import type { TableMeta } from '@/features/tables/components/table.types';
import { useCellEditor } from '@/features/tables/hooks/useCellEditor';
import type { RowFilter } from '@/features/tables/lib/filters';
import { isEditable, type FieldMeta } from '@/shared/ui/RowDrawer';
import { EmptyState } from '@/shared/ui/EmptyState';
import { SkeletonList } from '@/shared/ui/Skeleton';
import { DataGrid } from '@/features/tables/components/data-panel/DataGrid';
import { PagerBar } from '@/features/tables/components/data-panel/PagerBar';
import { QueryBar } from '@/features/tables/components/data-panel/QueryBar';
import { SelectionBar } from '@/features/tables/components/data-panel/SelectionBar';
import { TableHeading } from '@/features/tables/components/data-panel/TableHeading';

interface TableDataPanelProps {
  activeModel: string | undefined;
  meta: TableMeta | undefined;
  columns: FieldMeta[];
  rows: Record<string, unknown>[];
  total: number | undefined;
  /** `total` is the planner's estimate, not an exact count. */
  totalEstimated: boolean;
  loading: boolean;
  loaded: boolean;
  readOnly: boolean;
  search: string;
  filters: RowFilter[];
  sort: string | null;
  order: 'asc' | 'desc';
  page: number;
  pageSize: number;
  totalPages: number;
  foreignTableByColumn: Record<string, string>;
  modelByTable: Record<string, string>;
  onSearchChange: (value: string) => void;
  onFiltersChange: (filters: RowFilter[]) => void;
  onSort: (column: string) => void;
  onClearSort: () => void;
  onRefresh: () => void;
  onOpenSql: () => void;
  onNewRow: () => void;
  onOpenPermissions: () => void;
  onOpenForeignTable: (model: string) => void;
  onRowClick: (row: Record<string, unknown>) => void;
  onRowContextMenu: (event: MouseEvent, row: Record<string, unknown>) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  /** Primary keys (stringified) of the checked rows. */
  selected: string[];
  bulkDeleting: boolean;
  onToggleSelected: (key: unknown) => void;
  onToggleSelectAll: () => void;
  onClearSelection: () => void;
  onDeleteSelected: () => void;
  onUpdateCell: (row: Record<string, unknown>, column: string, value: unknown) => void;
}

function NoRows({ search, meta, canCreate, onNewRow }: { search: string; meta: TableMeta | undefined; canCreate: boolean; onNewRow: () => void }) {
  if (search) {
    return (
      <EmptyState
        title={`No match for "${search}"`}
        description="This filters the rows already loaded. Use the filter bar above to query the whole table."
      />
    );
  }
  return (
    <EmptyState
      mascot="hugging-postgres"
      title="No rows yet"
      description={meta ? `${meta.dbName} exists but is empty.` : undefined}
      action={canCreate ? <button onClick={onNewRow} className="btn btn-primary"><Plus size={14} /> New row</button> : undefined}
    />
  );
}

export function TableDataPanel({
  activeModel, meta, columns, rows, total, loading, loaded, readOnly,
  totalEstimated,
  search, filters, sort, order, page, pageSize, totalPages, foreignTableByColumn,
  modelByTable, onSearchChange, onFiltersChange, onSort, onClearSort, onRefresh,
  onOpenSql, onNewRow, onOpenPermissions, onOpenForeignTable, onRowClick,
  onRowContextMenu, onPageChange, onPageSizeChange,
  selected, bulkDeleting, onToggleSelected, onToggleSelectAll, onClearSelection,
  onDeleteSelected, onUpdateCell,
}: TableDataPanelProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Per table, and remembered: which columns matter is a property of the table,
  // not of this visit to it.
  const [hidden, setHidden] = useProjectPersistentState<string[]>(`table-hidden-cols:${activeModel ?? ''}`, []);
  const selectable = !readOnly && Boolean(meta);
  const editableColumns = useMemo(
    () => new Set(meta?.fields.filter(isEditable).map(field => field.name) ?? []),
    [meta?.fields],
  );

  const shownColumns = useMemo(() => {
    const visible = columns.filter(column => !hidden.includes(column.name));
    // Never hide the last column: an empty grid looks like a failed query.
    return visible.length > 0 ? visible : columns;
  }, [columns, hidden]);

  const editableOrder = useMemo(
    () => (selectable ? shownColumns.filter(column => editableColumns.has(column.name)) : []),
    [shownColumns, selectable, editableColumns],
  );
  const editor = useCellEditor({ rows, editableOrder, onUpdateCell });

  return (
    <>
      <TableHeading
        activeModel={activeModel}
        meta={meta}
        total={total}
        totalEstimated={totalEstimated}
        loaded={loaded}
        loading={loading}
        readOnly={readOnly}
        onOpenSql={onOpenSql}
        onOpenPermissions={onOpenPermissions}
        onNewRow={onNewRow}
      />

      <QueryBar
        activeModel={activeModel}
        rows={rows}
        columns={columns}
        shownColumns={shownColumns}
        hidden={hidden}
        onHiddenChange={setHidden}
        search={search}
        onSearchChange={onSearchChange}
        filters={filters}
        onFiltersChange={onFiltersChange}
        filtersOpen={filtersOpen}
        onFiltersOpenChange={setFiltersOpen}
        sort={sort}
        order={order}
        onClearSort={onClearSort}
        onRefresh={onRefresh}
      />

      {filtersOpen && <FilterEditor columns={columns.map(column => column.name)} filters={filters} onChange={onFiltersChange} />}

      {selected.length > 0 && (
        <SelectionBar count={selected.length} deleting={bulkDeleting} onClear={onClearSelection} onDelete={onDeleteSelected} />
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <DataGrid
          meta={meta}
          rows={rows}
          columns={shownColumns}
          editableColumns={editableColumns}
          selectable={selectable}
          readOnly={readOnly}
          selected={selected}
          sort={sort}
          order={order}
          editor={editor}
          foreignTableByColumn={foreignTableByColumn}
          modelByTable={modelByTable}
          onSort={onSort}
          onToggleSelected={onToggleSelected}
          onToggleSelectAll={onToggleSelectAll}
          onRowClick={onRowClick}
          onRowContextMenu={onRowContextMenu}
          onOpenForeignTable={onOpenForeignTable}
        />
        {loading && <SkeletonList rows={6} height={20} className="p-4" />}
        {loaded && rows.length === 0 && <NoRows search={search} meta={meta} canCreate={selectable} onNewRow={onNewRow} />}
      </div>

      <PagerBar
        loaded={loaded}
        page={page}
        pageSize={pageSize}
        total={total}
        totalEstimated={totalEstimated}
        totalPages={totalPages}
        showEditHint={selectable}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />
    </>
  );
}
