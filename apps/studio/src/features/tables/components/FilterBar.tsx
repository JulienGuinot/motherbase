import { Filter, Plus, X } from 'lucide-react';
import Select from '@/shared/ui/Select';
import {
  FILTER_OPERATORS,
  operatorHasValue,
  operatorLabel,
  completeFilters,
  type FilterOperator,
  type RowFilter,
} from '@/features/tables/lib/filters';

interface FilterBarProps {
  columns: string[];
  filters: RowFilter[];
  onChange: (filters: RowFilter[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Supabase-style server-side filter builder, in two pieces.
 *
 * The trigger and the applied chips sit inline in the table's query row; the
 * editor drops below it. They used to be one component owning a full-width band
 * of its own, which is how the grid ended up with three separate strips of
 * chrome stacked above the first row of data.
 */
export function FilterControl({ filters, onChange, open, onOpenChange }: Omit<FilterBarProps, 'columns'>) {
  const applied = completeFilters(filters);

  return (
    <>
      <button
        onClick={() => onOpenChange(!open)}
        className="btn"
        style={applied.length ? { color: 'var(--accent)', borderColor: 'var(--accent)' } : undefined}
        title="Filter rows on the server"
      >
        <Filter size={12} /> Filter{applied.length ? ` · ${applied.length}` : ''}
      </button>

      {applied.map((filter, index) => (
        <span key={index} className="chip mono" style={{ fontSize: 10 }}>
          {filter.column} {operatorLabel(filter.op)} {operatorHasValue(filter.op) ? filter.value : ''}
        </span>
      ))}

      {filters.length > 0 && (
        <button onClick={() => onChange([])} className="btn btn-ghost" title="Remove every filter">
          <X size={12} />
        </button>
      )}
    </>
  );
}

/** The editor rows, shown under the query row while the filter panel is open. */
export function FilterEditor({ columns, filters, onChange }: Omit<FilterBarProps, 'open' | 'onOpenChange'>) {
  function addFilter() {
    onChange([...filters, { column: columns[0] ?? '', op: 'eq', value: '' }]);
  }
  function updateFilter(index: number, patch: Partial<RowFilter>) {
    onChange(filters.map((filter, i) => (i === index ? { ...filter, ...patch } : filter)));
  }
  function removeFilter(index: number) {
    onChange(filters.filter((_, i) => i !== index));
  }

  return (
    <div className="shrink-0 space-y-2 border-b hairline px-4 py-3" style={{ background: 'var(--surface-2)' }}>
      {filters.map((filter, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <Select
            value={filter.column}
            onChange={value => updateFilter(index, { column: value })}
            ariaLabel="Filter column"
            style={{ width: '11rem', fontFamily: 'var(--font-mono)', fontSize: 11 }}
            options={columns.map(column => ({ value: column, label: column }))}
          />
          <Select
            value={filter.op}
            onChange={value => updateFilter(index, { op: value as FilterOperator })}
            ariaLabel="Filter operator"
            style={{ width: '7rem', fontSize: 11 }}
            options={FILTER_OPERATORS.map(operator => ({ value: operator.op, label: operator.label }))}
          />
          {operatorHasValue(filter.op) && (
            <input
              value={filter.value}
              onChange={event => updateFilter(index, { value: event.target.value })}
              placeholder={filter.op === 'in' ? 'a, b, c' : 'value'}
              className="input"
              style={{ width: '12rem', fontSize: 12 }}
            />
          )}
          <button onClick={() => removeFilter(index)} className="btn btn-ghost" title="Remove filter">
            <X size={12} />
          </button>
        </div>
      ))}

      <button onClick={addFilter} className="btn btn-ghost" style={{ color: 'var(--accent)' }}>
        <Plus size={12} /> Add filter
      </button>

      {filters.length === 0 && (
        <p className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
          Filters run on the server, across the whole table. The search box filters the loaded page only.
        </p>
      )}
    </div>
  );
}
