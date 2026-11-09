'use client';

import { Activity, Filter } from 'lucide-react';
import { CodeBlock } from '@/shared/ui/CodeBlock';
import { EmptyState } from '@/shared/ui/EmptyState';
import { SkeletonList } from '@/shared/ui/Skeleton';
import {
  ALL_MESSAGE_TYPES,
  MESSAGE_TYPE_META,
  classifyMessage,
  type MessageType,
} from '@/features/database/lib/realtime-messages';
import type { RealtimeEvent } from '@/features/database/types';

/** One toggle per message type, showing how many of each arrived. */
function TypeFilters({
  active,
  counts,
  onToggle,
}: {
  active: Set<MessageType>;
  counts: Record<MessageType, number>;
  onToggle: (type: MessageType) => void;
}) {
  return (
    // Wraps: the four type filters are 373px of chips, so on a phone the last
    // one (System) sat off the right edge and could not be toggled at all.
    <div className="flex flex-wrap items-center gap-1.5">
      {ALL_MESSAGE_TYPES.map(type => {
        const meta = MESSAGE_TYPE_META[type];
        const on = active.has(type);
        return (
          <button
            key={type}
            onClick={() => onToggle(type)}
            className="chip text-[11px]"
            style={{ cursor: 'pointer', opacity: on ? 1 : 0.4, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            title={`Toggle ${meta.label}`}
          >
            <span style={{ width: 7, height: 7, borderRadius: 2, background: meta.color }} />
            {meta.label}
            <span className="tabular-nums" style={{ color: 'var(--text-mute)' }}>
              {counts[type]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** One line for the collapsed row. */
function inlinePayload(payload: unknown): string {
  return typeof payload === 'object' && payload !== null ? JSON.stringify(payload) : String(payload ?? '');
}

/** The whole thing, indented, for the expanded row. A payload arrives over the
 *  wire as JSON, so the only way stringify can fail here is a value the log
 *  itself put there; fall back to the raw form rather than blanking the row. */
function fullPayload(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return String(payload ?? '');
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

export function RealtimeMessageLog({
  events,
  isLoading,
  counts,
  typeFilter,
  onToggleType,
  search,
  onSearch,
  onContextMenu,
}: {
  events: RealtimeEvent[];
  isLoading: boolean;
  counts: Record<MessageType, number>;
  typeFilter: Set<MessageType>;
  onToggleType: (type: MessageType) => void;
  search: string;
  onSearch: (value: string) => void;
  onContextMenu: (event: React.MouseEvent, realtimeEvent: RealtimeEvent) => void;
}) {
  return (
    <div className="card flex flex-col overflow-hidden" style={{ maxHeight: 480 }}>
      <div className="flex flex-wrap items-center gap-3 border-b hairline px-4 py-3">
        <Activity size={13} style={{ color: 'var(--text-mute)' }} />
        <span className="text-[13px]" style={{ fontWeight: 600 }}>
          Messages
        </span>

        <TypeFilters active={typeFilter} counts={counts} onToggle={onToggleType} />

        <div
          className="ml-auto flex items-center gap-2 border hairline-strong px-2 py-1"
          style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
        >
          <Filter size={11} style={{ color: 'var(--text-mute)' }} />
          <input
            value={search}
            onChange={e => onSearch(e.target.value)}
            placeholder="Filter by event or channel..."
            className="w-44 bg-transparent text-[12px] outline-none placeholder:opacity-50"
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading && <SkeletonList rows={5} height={24} className="p-3" />}

        {!isLoading && events.length === 0 && (
          <EmptyState mascot="listening-sonar" title="No events yet" description="Messages appear here in real time as your app broadcasts them." />
        )}

        {events.map((event, index) => {
          const meta = MESSAGE_TYPE_META[classifyMessage(event)];
          return (
            // <details> rather than a click handler and a Set of open ids: the
            // row is expandable, focusable and keyboard-operable with no state
            // to keep, and the log can rerender on every incoming message
            // without closing what the operator opened.
            <details
              key={`${event.at}-${index}`}
              onContextMenu={e => onContextMenu(e, event)}
              className="border-b hairline"
            >
              <summary className="flex cursor-pointer list-none items-start gap-4 px-4 py-2.5 text-[12px] [&::-webkit-details-marker]:hidden">
                <span className="shrink-0 tabular-nums" style={{ color: 'var(--text-mute)' }}>
                  {new Date(event.at).toLocaleTimeString()}
                </span>
                <span
                  className="shrink-0 text-[10px]"
                  style={{
                    color: meta.color,
                    background: `color-mix(in srgb, ${meta.color} 15%, transparent)`,
                    padding: '2px 7px',
                    borderRadius: 5,
                    fontWeight: 650,
                  }}
                >
                  {meta.label}
                </span>
                {/* The channel and the event name are the two parts of this row
                    that can be arbitrarily long, and they were the two that
                    refused to shrink: on a phone they pushed the payload, and
                    themselves, off the right edge. */}
                <span className="mono min-w-0 max-w-[40%] truncate" style={{ color: 'var(--text-mute)' }}>
                  {event.channel}
                </span>
                <span className="min-w-0 max-w-[40%] truncate font-medium" style={{ color: 'var(--text-dim)' }}>
                  {event.event}
                </span>
                <span className="mono min-w-0 flex-1 truncate" style={{ color: 'var(--text-dim)' }}>
                  {inlinePayload(event.payload)}
                </span>
              </summary>
              <div className="mx-4 mb-3">
                <CodeBlock
                  value={fullPayload(event.payload)}
                  label={`${event.channel} / ${event.event}`}
                  maxHeight={288}
                />
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}
