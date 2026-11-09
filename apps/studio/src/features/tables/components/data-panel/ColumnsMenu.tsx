import { useState } from 'react';
import { Check, Columns3 } from 'lucide-react';
import type { FieldMeta } from '@/shared/ui/RowDrawer';

/**
 * Which columns are on screen. Wide tables are the normal case here (an audit
 * or a join table runs to thirty columns) and until now the only way to stop
 * looking at twenty of them was to scroll past them on every row.
 */
export function ColumnsMenu({
  columns,
  hidden,
  onToggle,
  onShowAll,
}: {
  columns: FieldMeta[];
  hidden: string[];
  onToggle: (name: string) => void;
  onShowAll: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} className="btn" title="Show or hide columns">
        <Columns3 size={14} />
        {hidden.length > 0 && <span className="tabular-nums">{columns.length - hidden.length}/{columns.length}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            // Opens to the right of its button. The workbench section around
            // this panel is `overflow-hidden`, so a right-anchored menu on a
            // left-hand button spilled past the section's left edge and was
            // clipped away behind the table sidebar.
            className="absolute left-0 z-50 mt-1 max-h-[320px] w-[220px] overflow-y-auto rounded-md border py-1"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-pop)' }}
          >
            <button onClick={onShowAll} className="nav-item flex w-full items-center px-3 py-2 text-[12px]" style={{ color: 'var(--text-dim)' }}>
              Show all
            </button>
            <div className="my-1 border-t hairline" />
            {columns.map(column => {
              const shown = !hidden.includes(column.name);
              return (
                <button
                  key={column.name}
                  onClick={() => onToggle(column.name)}
                  className="nav-item flex w-full items-center gap-2 px-3 py-1.5 text-[12px]"
                  style={{ color: shown ? 'var(--text)' : 'var(--text-mute)' }}
                >
                  <span style={{ width: 14 }}>{shown && <Check size={13} color="var(--accent)" />}</span>
                  <span className="flex-1 truncate text-left">{column.name}</span>
                  <span className="mono text-[9px] opacity-50">{column.type}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
