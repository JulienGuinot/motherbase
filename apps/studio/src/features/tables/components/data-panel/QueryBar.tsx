import { RefreshCw, Search, X } from 'lucide-react';
import ExportButton from '@/shared/ui/ExportButton';
import type { FieldMeta } from '@/shared/ui/RowDrawer';
import { FilterControl } from '@/features/tables/components/FilterBar';
import type { RowFilter } from '@/features/tables/lib/filters';
import { ColumnsMenu } from './ColumnsMenu';

/**
 * One query row: narrow the rows on the left, take them away on the right.
 * The sort state joins the filter chips it belongs with, instead of holding a
 * third strip of its own below this one.
 */
export function QueryBar({
  activeModel,
  rows,
  columns,
  shownColumns,
  hidden,
  onHiddenChange,
  search,
  onSearchChange,
  filters,
  onFiltersChange,
  filtersOpen,
  onFiltersOpenChange,
  sort,
  order,
  onClearSort,
  onRefresh,
}: {
  activeModel: string | undefined;
  rows: Record<string, unknown>[];
  columns: FieldMeta[];
  shownColumns: FieldMeta[];
  hidden: string[];
  onHiddenChange: (update: (current: string[]) => string[]) => void;
  search: string;
  onSearchChange: (value: string) => void;
  filters: RowFilter[];
  onFiltersChange: (filters: RowFilter[]) => void;
  filtersOpen: boolean;
  onFiltersOpenChange: (open: boolean) => void;
  sort: string | null;
  order: 'asc' | 'desc';
  onClearSort: () => void;
  onRefresh: () => void;
}) {
  const toggleColumn = (name: string) =>
    onHiddenChange(current => (current.includes(name) ? current.filter(n => n !== name) : [...current, name]));

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b hairline px-4 py-2">
      {/* `.input` is width:100%, which made this eat the whole band and push
          every other control onto a second line. */}
      <div className="input flex items-center gap-2 py-1.5" style={{ background: 'var(--surface-2)', width: 'auto' }}>
        <Search size={12} style={{ color: 'var(--text-mute)' }} />
        <input value={search} onChange={event => onSearchChange(event.target.value)} placeholder="Filter loaded rows…" className="w-44 bg-transparent text-[12px] outline-none placeholder:opacity-60" />
      </div>

      <FilterControl filters={filters} onChange={onFiltersChange} open={filtersOpen} onOpenChange={onFiltersOpenChange} />

      <ColumnsMenu columns={columns} hidden={hidden} onToggle={toggleColumn} onShowAll={() => onHiddenChange(() => [])} />

      {sort && (
        <span className="chip" title="Click a column header to change the sort">
          {sort} · {order}
          <button onClick={onClearSort} className="ml-1" title="Clear sort" style={{ color: 'var(--text-mute)' }}>
            <X size={10} />
          </button>
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        <button onClick={onRefresh} className="btn btn-ghost" title="Refresh"><RefreshCw size={14} /></button>
        {/* Exports what is on screen, not what is in the table: hiding a column
            and then getting it back in the CSV is the wrong surprise. */}
        <ExportButton filename={String(activeModel)} columns={shownColumns.map(column => ({ key: column.name }))} rows={rows} />
      </div>
    </div>
  );
}
