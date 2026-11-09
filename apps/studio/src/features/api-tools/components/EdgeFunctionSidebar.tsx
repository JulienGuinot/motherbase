'use client';

import { ChevronRight, Clock, KeyRound, Plus } from 'lucide-react';
import { EmptyState } from '@/shared/ui/EmptyState';
import { SidebarHeader } from '@/shared/ui/SidebarHeader';
import { Skeleton } from '@/shared/ui/Skeleton';
import { WriteButton } from '@/shared/ui/WriteButton';
import type { EdgeFn } from '@/features/api-tools/types';

export function EdgeFunctionSidebar({
  functions,
  isLoading,
  selectedId,
  secretsOpen,
  onOpen,
  onNew,
  onOpenSecrets,
  onContextMenu,
}: {
  functions: EdgeFn[];
  isLoading: boolean;
  selectedId?: string;
  secretsOpen: boolean;
  onOpen: (fn: EdgeFn) => void;
  onNew: () => void;
  onOpenSecrets: () => void;
  onContextMenu: (event: React.MouseEvent, fn: EdgeFn) => void;
}) {
  return (
    <aside
      className="flex h-[220px] w-full shrink-0 flex-col overflow-hidden border-b hairline md:h-auto md:w-64 md:border-b-0 md:border-r"
      style={{ background: 'var(--surface-2)' }}
    >
      <SidebarHeader
        title="Edge fn(x)"
        actions={
          <>
            <button
              onClick={onOpenSecrets}
              className="btn btn-ghost"
              title="Project secrets"
              style={{ padding: '2px 8px', fontSize: 11, color: secretsOpen ? 'var(--accent)' : undefined }}
            >
              <KeyRound size={12} />
            </button>
            <WriteButton onClick={onNew} className="btn btn-primary" style={{ padding: '2px 8px', fontSize: 11 }}>
              <Plus size={11} /> New
            </WriteButton>
          </>
        }
      />

      <ul className="flex-1 overflow-auto">
        {functions.map(fn => {
          const active = selectedId === fn.id;
          return (
            <li key={fn.id} onContextMenu={e => onContextMenu(e, fn)}>
              <button
                onClick={() => onOpen(fn)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13px]"
                style={{
                  background: active ? 'var(--surface)' : 'transparent',
                  borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
                }}
              >
                <div className="flex-1 overflow-hidden">
                  <div className="truncate font-medium">{fn.name}</div>
                  <div className="mono truncate text-[10px]" style={{ color: 'var(--text-mute)' }}>
                    /{fn.route}
                  </div>
                </div>
                {fn.schedule && <Clock size={11} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />}
                <span className="dot" style={{ background: fn.enabled ? 'var(--green)' : 'var(--text-mute)', flexShrink: 0 }} />
                <ChevronRight size={11} style={{ color: 'var(--text-mute)' }} />
              </button>
            </li>
          );
        })}

        {isLoading && (
          <li>
            <Skeleton className="mx-3 my-2 h-6" />
          </li>
        )}

        {!isLoading && functions.length === 0 && <EmptyState as="li" title="No edge functions yet" description="Create one to run code on your own routes." />}
      </ul>
    </aside>
  );
}
