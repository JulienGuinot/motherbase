'use client';

import { useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import SchemaSelect from '@/shared/ui/SchemaSelect';
import { Skeleton } from '@/shared/ui/Skeleton';
import type { SchemaTable } from '@/shared/types/schema';

/**
 * Tables and columns of the selected schema. Clicking a column inserts its
 * quoted name into the editor, which is faster than typing it correctly.
 */
export function SchemaExplorer({
  tables,
  isLoading,
  isError,
  open,
  mobileOpen,
  onOpen,
  onClose,
  onInsert,
}: {
  tables: SchemaTable[] | undefined;
  isLoading: boolean;
  isError: boolean;
  open: boolean;
  mobileOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onInsert: (text: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (name: string) =>
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  if (!open) {
    return (
      <button
        onClick={onOpen}
        className="hidden w-8 shrink-0 items-center justify-center border-r hairline hover:bg-[var(--ink-2)] md:flex"
        title="Show schema explorer"
      >
        <ChevronRight size={12} />
      </button>
    );
  }

  return (
    <aside
      className={`${mobileOpen
        ? 'fixed inset-x-2 bottom-[calc(64px+env(safe-area-inset-bottom))] top-16 z-50 flex rounded-lg border shadow-xl'
        : 'hidden'
        } w-auto shrink-0 flex-col overflow-hidden hairline md:static md:flex md:w-56 md:rounded-none md:border-0 md:border-r md:shadow-none`}
      style={{ background: 'var(--ink-2)' }}
    >
      <div className="flex items-center gap-2 border-b hairline px-3 py-2">
        <SchemaSelect className="min-w-0 flex-1" />
        <button onClick={onClose} className="btn btn-ghost p-0.5" title="Hide schema explorer">
          <ChevronLeft size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-auto py-1 text-[12px]">
        {isLoading && <Skeleton className="mx-3 my-2 h-4" />}
        {isError && (
          <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--danger)' }}>
            Unable to load schema.
          </div>
        )}

        {tables?.map(table => (
          <div key={table.name}>
            <button
              onClick={() => toggle(table.name)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--ink-3)]"
            >
              <span style={{ color: 'var(--text-mute)', fontSize: 10 }}>{expanded.has(table.name) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
              <span className="truncate font-medium">{table.name}</span>
              <span className="ml-auto text-[10px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
                {table.columns.length}
              </span>
            </button>

            {expanded.has(table.name) && (
              <ul className="pb-1 pl-6">
                {table.columns.map(column => (
                  <li key={column.name}>
                    <button
                      onClick={() => onInsert(`"${column.name}"`)}
                      className="flex w-full items-center gap-2 px-2 py-0.5 text-left hover:bg-[var(--ink-3)]"
                      title={`Click to insert "${column.name}"`}
                    >
                      {column.isPrimaryKey && <span style={{ color: 'var(--accent)', fontSize: 9 }}>PK</span>}
                      <span className="truncate" style={{ color: 'var(--paper-dim)' }}>
                        {column.name}
                      </span>
                      <span className="mono ml-auto text-[10px]" style={{ color: 'var(--paper-mute)' }}>
                        {column.type}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
