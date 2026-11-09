'use client';

import { AlertTriangle, Inbox } from 'lucide-react';
import { formatRelativeTime } from '@/shared/lib/format';
import { useRealtimeQueue } from '@/features/database/hooks/useRealtime';

/**
 * Health of the durable delivery queue behind realtime.
 *
 * The page next to this one is a traffic inspector: live channels, presence,
 * and the last few hundred events held in memory. None of that says anything
 * about events that were accepted and never delivered, which is the failure an
 * operator actually needs to see. Those rows sit in
 * `platform.realtime_outbox`, and until now the only way to look at them was to
 * read the system table by hand.
 */
export function RealtimeQueuePanel() {
  const { data, isError } = useRealtimeQueue();
  const queue = data?.queue;

  // "Could not read" must never render as a healthy zero: that is exactly the
  // shape of the bug where a mistyped relation name reported an empty queue.
  if (isError || (queue && !queue.measured)) {
    return (
      <div
        className="flex items-center gap-2 border px-3 py-2.5 text-[12px]"
        style={{
          borderColor: 'color-mix(in srgb, var(--amber) 40%, transparent)',
          background: 'color-mix(in srgb, var(--amber) 8%, var(--surface))',
          borderRadius: 'var(--radius-md)',
        }}
        role="status"
      >
        <AlertTriangle size={14} style={{ color: 'var(--amber)', flexShrink: 0 }} />
        <span>Delivery queue depth is unavailable right now, so nothing here should be read as healthy.</span>
      </div>
    );
  }

  if (!queue) return null;

  const stat = (label: string, value: number, color?: string) => (
    <div key={label} className="flex items-baseline gap-1.5">
      <span className="tabular-nums text-[15px]" style={{ color: color ?? 'var(--text)', fontWeight: 600 }}>
        {value.toLocaleString()}
      </span>
      <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
        {label}
      </span>
    </div>
  );

  return (
    <div className="card space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-4">
        <Inbox size={14} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
        {stat('pending', queue.pending)}
        {stat('in flight', queue.processing)}
        {stat('undeliverable', queue.failed, queue.failed > 0 ? 'var(--danger)' : undefined)}
        {queue.oldestPendingAt && (
          <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
            oldest waiting {formatRelativeTime(queue.oldestPendingAt)}
          </span>
        )}
        {data?.inspectorRetained !== undefined && (
          <span className="ml-auto text-[11px]" style={{ color: 'var(--text-mute)' }}>
            inspector keeps the last {data.inspectorRetained} events, in memory
          </span>
        )}
      </div>

      {queue.lastFailure && (
        <div className="mono text-[11px]" style={{ color: 'var(--danger)' }}>
          last permanent failure {formatRelativeTime(queue.lastFailure.at)} · {queue.lastFailure.model}.
          {queue.lastFailure.action}
          {queue.lastFailure.error ? ` · ${queue.lastFailure.error}` : ''}
        </div>
      )}
    </div>
  );
}
