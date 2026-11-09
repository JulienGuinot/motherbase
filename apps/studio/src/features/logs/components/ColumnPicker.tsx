'use client';

import { useRef, useState } from 'react';
import { Check, Columns3, RotateCcw } from 'lucide-react';
import { Popover } from '@/shared/ui/Popover';
import type { LogLike } from '@/features/logs/lib/log-stream';
import type { LogColumnsState } from '@/features/logs/lib/columns';

/**
 * Which columns the stream shows. The metadata the server records per request
 * (caller IP, user agent, authenticated user, request id) is far more than a
 * row can hold at once, so the operator picks; the choice is remembered per
 * browser.
 */
export default function ColumnPicker<T extends LogLike>({ columns }: { columns: LogColumnsState<T> }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const optional = columns.all.filter(column => !column.required);
  const extras = columns.visible.filter(column => !column.required && !column.defaultOn).length;

  return (
    <>
      <button
        ref={button}
        onClick={() => setOpen(o => !o)}
        className="btn"
        title="Choose columns"
        style={extras > 0 ? { color: 'var(--text)' } : undefined}
      >
        <Columns3 size={12} /> Columns{extras > 0 ? ` (${extras})` : ''}
      </button>

      {open && (
        <Popover anchor={button} onClose={() => setOpen(false)} width={210} align="end">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="label" style={{ fontSize: 10 }}>columns</span>
            <button onClick={columns.reset} className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-mute)' }}>
              <RotateCcw size={10} /> reset
            </button>
          </div>

          {optional.map(column => {
            const on = columns.visible.some(visible => visible.key === column.key);
            return (
              <button
                key={column.key}
                onClick={() => columns.toggle(column.key)}
                className="nav-item flex w-full items-center gap-2 px-3 py-1.5 text-[12px]"
                style={{ color: 'var(--text-dim)' }}
              >
                <span
                  className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border"
                  style={{
                    borderColor: on ? 'var(--accent)' : 'var(--border)',
                    background: on ? 'var(--accent)' : 'transparent',
                  }}
                >
                  {on && <Check size={10} color="var(--accent-fg)" />}
                </span>
                <span className="flex-1 truncate text-left">{column.label}</span>
              </button>
            );
          })}
        </Popover>
      )}
    </>
  );
}
