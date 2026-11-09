'use client';

import { Copy, Edit2, Send, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { EmptyState } from '@/shared/ui/EmptyState';
import { SkeletonList } from '@/shared/ui/Skeleton';
import { useCopy } from '@/shared/hooks/useCopy';
import { formatEventSpec } from '@/shared/lib/event-utils';
import type { Hook } from '@/features/database/types';

interface EventTable {
  model: string;
}

export function WebhookList({
  hooks,
  isLoading,
  eventTables,
  testing,
  onOpen,
  onEdit,
  onToggle,
  onTest,
  onDelete,
  onContextMenu,
}: {
  hooks: Hook[];
  isLoading: boolean;
  eventTables: EventTable[];
  testing: boolean;
  onOpen: (hook: Hook) => void;
  onEdit: (hook: Hook) => void;
  onToggle: (hook: Hook) => void;
  onTest: (id: string) => void;
  onDelete: (hook: Hook) => void;
  onContextMenu: (event: React.MouseEvent, hook: Hook) => void;
}) {
  const copy = useCopy();

  if (isLoading) return <SkeletonList rows={3} className="card p-4" />;

  if (hooks.length === 0) {
    return (
      <div className="card">
        <EmptyState
          size="md"
          mascot="webhook"
          title="No webhooks yet"
          description="Fan out events to external services: analytics, Slack, your own audit log. Create one and send a test payload."
        />
      </div>
    );
  }

  return (
    <div className="grid gap-3 rise-stagger">
      {hooks.map(hook => (
        <div
          key={hook.id}
          className="card flex flex-wrap items-start gap-4 p-4"
          onContextMenu={e => onContextMenu(e, hook)}
        >
          <div className="flex items-center gap-3">
            <button onClick={() => onToggle(hook)} title={hook.enabled ? 'Disable' : 'Enable'}>
              {hook.enabled ? (
                <ToggleRight size={26} style={{ color: 'var(--green)' }} />
              ) : (
                <ToggleLeft size={26} style={{ color: 'var(--text-mute)' }} />
              )}
            </button>
            <button onClick={() => onOpen(hook)} className="text-left" title="Open details">
              <div className="text-[14px] font-medium hover:underline">{hook.name}</div>
              <div className="mono mt-1 text-[11px]" style={{ color: 'var(--text-mute)' }}>
                {hook.url}
              </div>
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {hook.events.map(event => (
              <span key={event} className="chip">
                {formatEventSpec(event, eventTables)}
              </span>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-1">
            <button onClick={() => onEdit(hook)} className="btn btn-ghost" title="Edit webhook">
              <Edit2 size={12} />
            </button>
            <button onClick={() => copy(hook.url, 'URL copied')} className="btn btn-ghost" title="Copy URL">
              <Copy size={12} />
            </button>
            <button
              onClick={() => onTest(hook.id)}
              className="btn btn-ghost"
              title="Send test payload"
              disabled={testing}
            >
              <Send size={12} />
            </button>
            <button
              onClick={() => onDelete(hook)}
              className="btn btn-ghost"
              style={{ color: 'var(--danger)' }}
              title="Delete webhook"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
