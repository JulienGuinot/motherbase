/**
 * Pick several columns by toggling chips. Used rather than a native
 * multi-select: picking several there needs ctrl-click, which nothing on
 * screen tells you. The order of `value` is the click order, which is the
 * column order of an index.
 */
export function ColumnChips({
  columns,
  value,
  onChange,
  className = '',
}: {
  columns: string[];
  value: string[];
  onChange: (next: string[]) => void;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap content-start gap-1.5 ${className}`}>
      {columns.map(column => {
        const picked = value.includes(column);
        return (
          <button
            key={column}
            type="button"
            aria-pressed={picked}
            onClick={() => onChange(picked ? value.filter(c => c !== column) : [...value, column])}
            className="chip mono transition-colors"
            style={{
              background: picked ? 'var(--accent-soft)' : 'transparent',
              borderColor: picked ? 'var(--accent)' : 'var(--border)',
              color: picked ? 'var(--text)' : 'var(--text-dim)',
            }}
          >
            {column}
          </button>
        );
      })}
    </div>
  );
}
