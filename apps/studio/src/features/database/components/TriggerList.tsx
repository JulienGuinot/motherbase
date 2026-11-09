'use client';

import { useMemo } from 'react';
import { Edit2, ToggleLeft, ToggleRight, Trash2, Zap } from 'lucide-react';
import { EmptyState } from '@/shared/ui/EmptyState';
import { SkeletonList } from '@/shared/ui/Skeleton';
import type { TriggerInfo } from '@/features/database/types';

function TriggerCard({
  trigger,
  onToggle,
  onEdit,
  onDrop,
  onContextMenu,
}: {
  trigger: TriggerInfo;
  onToggle: (trigger: TriggerInfo) => void;
  onEdit: (trigger: TriggerInfo) => void;
  onDrop: (trigger: TriggerInfo) => void;
  onContextMenu: (event: React.MouseEvent, trigger: TriggerInfo) => void;
}) {
  return (
    <div className="card flex flex-wrap items-start gap-4 p-4" onContextMenu={e => onContextMenu(e, trigger)}>
      <div className="flex items-center gap-3">
        <button onClick={() => onToggle(trigger)} title={trigger.enabled ? 'Disable' : 'Enable'}>
          {trigger.enabled ? (
            <ToggleRight size={26} style={{ color: 'var(--green)' }} />
          ) : (
            <ToggleLeft size={26} style={{ color: 'var(--text-mute)' }} />
          )}
        </button>
        <div>
          <div className="text-[14px] font-medium">{trigger.name}</div>
          <div className="mono mt-1 text-[11px]" style={{ color: 'var(--paper-mute)' }}>
            {trigger.timing} · FOR EACH {trigger.orientation}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {trigger.events.map(event => (
          <span key={event} className="chip">
            {event}
          </span>
        ))}
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <Zap size={13} />
        <span className="mono max-w-xs truncate text-[11px]" style={{ color: 'var(--paper-mute)' }}>
          {trigger.function}()
        </span>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <button onClick={() => onEdit(trigger)} className="btn btn-ghost" title="Edit trigger">
          <Edit2 size={12} />
        </button>
        <button
          onClick={() => onDrop(trigger)}
          className="btn btn-ghost"
          style={{ color: 'var(--danger)' }}
          title="Drop trigger"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

/** Triggers grouped by the table they fire on. */
export function TriggerList({
  triggers,
  isLoading,
  onToggle,
  onEdit,
  onDrop,
  onContextMenu,
}: {
  triggers: TriggerInfo[];
  isLoading: boolean;
  onToggle: (trigger: TriggerInfo) => void;
  onEdit: (trigger: TriggerInfo) => void;
  onDrop: (trigger: TriggerInfo) => void;
  onContextMenu: (event: React.MouseEvent, trigger: TriggerInfo) => void;
}) {
  const byTable = useMemo(() => {
    const map = new Map<string, TriggerInfo[]>();
    for (const trigger of triggers) {
      map.set(trigger.table, [...(map.get(trigger.table) ?? []), trigger]);
    }
    return Array.from(map.entries());
  }, [triggers]);

  if (isLoading) return <SkeletonList rows={3} className="card p-4" />;

  if (triggers.length === 0) {
    return (
      <div className="card">
        <EmptyState
          size="md"
          mascot="plug-cable"
          title="No triggers yet"
          description="Create a trigger to run a function BEFORE or AFTER inserts, updates, or deletes on a table."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {byTable.map(([table, list]) => (
        <div key={table}>
          <div className="mono mb-2 ml-1 text-[11px]" style={{ color: 'var(--paper-mute)' }}>
            public.{table}
          </div>
          <div className="grid gap-3 rise-stagger">
            {list.map(trigger => (
              <TriggerCard
                key={`${trigger.table}.${trigger.name}`}
                trigger={trigger}
                onToggle={onToggle}
                onEdit={onEdit}
                onDrop={onDrop}
                onContextMenu={onContextMenu}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
