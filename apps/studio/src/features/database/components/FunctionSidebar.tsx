'use client';

import { ChevronRight, Plus } from 'lucide-react';
import { EmptyState } from '@/shared/ui/EmptyState';
import SchemaSelect from '@/shared/ui/SchemaSelect';
import { Skeleton } from '@/shared/ui/Skeleton';
import { SidebarHeader } from '@/shared/ui/SidebarHeader';
import { WriteButton } from '@/shared/ui/WriteButton';
import type { FnInfo } from '@/features/database/types';

export function FunctionSidebar({
  functions,
  isLoading,
  selected,
  onSelect,
  onNew,
  onContextMenu,
}: {
  functions: FnInfo[];
  isLoading: boolean;
  selected: FnInfo | null;
  onSelect: (fn: FnInfo) => void;
  onNew: () => void;
  onContextMenu: (event: React.MouseEvent, fn: FnInfo) => void;
}) {
  return (
    <aside
      className="flex h-[220px] w-full shrink-0 flex-col overflow-hidden border-b hairline md:h-auto md:w-64 md:border-b-0 md:border-r"
      style={{ background: 'var(--surface-2)' }}
    >
      <SidebarHeader
        title="SQL Functions"
        actions={
          <WriteButton onClick={onNew} className="btn btn-primary" style={{ padding: '2px 8px', fontSize: 11 }}>
            <Plus size={11} /> New
          </WriteButton>
        }
      >
        <SchemaSelect className="w-full justify-start" />
      </SidebarHeader>

      <ul className="flex-1 overflow-auto">
        {functions.map(fn => {
          const active = selected?.signature === fn.signature;
          return (
            <li key={fn.signature} onContextMenu={e => onContextMenu(e, fn)}>
              <button
                onClick={() => onSelect(fn)}
                className="flex w-full items-center justify-between px-4 py-2 text-left text-[13px]"
                style={{
                  background: active ? 'var(--ink-3)' : 'transparent',
                  borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
                }}
              >
                {/* The arguments are part of the name here: two overloads are
                    two different functions. */}
                <span className="mono truncate" title={`${fn.name}(${fn.args})`}>
                  {fn.name}
                  <span style={{ color: 'var(--text-mute)' }}>({fn.args})</span>
                </span>
                <ChevronRight size={11} style={{ color: 'var(--paper-mute)' }} />
              </button>
            </li>
          );
        })}

        {isLoading && (
          <li>
            <Skeleton className="mx-3 my-2 h-5" />
          </li>
        )}

        {!isLoading && functions.length === 0 && <EmptyState as="li" title="No functions yet" description="Postgres functions you define show up here." />}
      </ul>
    </aside>
  );
}
