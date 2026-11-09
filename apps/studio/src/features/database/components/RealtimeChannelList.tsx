'use client';

import { Radio } from 'lucide-react';
import { EmptyState } from '@/shared/ui/EmptyState';
import { SkeletonList } from '@/shared/ui/Skeleton';
import type { ChannelInfo } from '@/features/database/types';

/** Active channels, with "All channels" as the unfiltered default. */
export function RealtimeChannelList({
  channels,
  isLoading,
  selected,
  onSelect,
  onContextMenu,
}: {
  channels: ChannelInfo[];
  isLoading: boolean;
  selected: string | null;
  onSelect: (name: string | null) => void;
  onContextMenu: (event: React.MouseEvent, channel: ChannelInfo) => void;
}) {
  const rowStyle = (active: boolean) => ({
    background: active ? 'var(--surface-2)' : 'transparent',
    borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
  });

  return (
    <div className="card flex flex-col overflow-hidden" style={{ maxHeight: 500 }}>
      <div className="flex items-center justify-between border-b hairline px-4 py-3">
        <span className="text-[13px]" style={{ fontWeight: 600 }}>
          Active channels
        </span>
        <span className="chip tabular-nums">{channels.length}</span>
      </div>

      <ul className="flex-1 overflow-auto">
        {isLoading && (
          <li className="p-3">
            <SkeletonList rows={4} height={32} />
          </li>
        )}

        <li>
          <button
            onClick={() => onSelect(null)}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13px]"
            style={rowStyle(!selected)}
          >
            <Radio size={13} />
            <span>All channels</span>
          </button>
        </li>

        {channels.map(channel => (
          <li key={channel.name} onContextMenu={e => onContextMenu(e, channel)}>
            <button
              onClick={() => onSelect(channel.name)}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13px]"
              style={rowStyle(selected === channel.name)}
            >
              <span className="mono flex-1 truncate">{channel.name}</span>
              <span className="chip tabular-nums">{channel.clientCount}</span>
            </button>
          </li>
        ))}

        {!isLoading && channels.length === 0 && <EmptyState as="li" title="No active channels" description="A channel appears as soon as a client subscribes to it." />}
      </ul>
    </div>
  );
}
