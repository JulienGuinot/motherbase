'use client';

import { Copy, Eye, Filter, X } from 'lucide-react';
import { ContextMenu } from '@/shared/ui/ContextMenu';
import { useCopy } from '@/shared/hooks/useCopy';
import type { ChannelInfo, RealtimeEvent } from '@/features/database/types';

export function ChannelContextMenu({
  x,
  y,
  channel,
  selected,
  onClose,
  onInspect,
  onFilter,
  onClearSelection,
}: {
  x: number;
  y: number;
  channel: ChannelInfo;
  selected: string | null;
  onClose: () => void;
  onInspect: (name: string) => void;
  onFilter: (value: string) => void;
  onClearSelection: () => void;
}) {
  const copy = useCopy();

  return (
    <ContextMenu
      x={x}
      y={y}
      onClose={onClose}
      items={[
        { label: 'Inspect channel', icon: <Eye size={13} />, action: () => onInspect(channel.name) },
        { label: 'Filter inspector by name', icon: <Filter size={13} />, action: () => onFilter(channel.name) },
        { type: 'separator' as const },
        { label: 'Copy channel name', icon: <Copy size={13} />, action: () => copy(channel.name, 'Channel copied') },
        {
          label: 'Copy as JSON',
          icon: <Copy size={13} />,
          action: () => copy(JSON.stringify(channel, null, 2), 'JSON copied'),
        },
        { type: 'separator' as const },
        {
          label: 'Clear selection',
          icon: <X size={13} />,
          disabled: selected !== channel.name,
          action: onClearSelection,
        },
      ]}
    />
  );
}

export function MessageContextMenu({
  x,
  y,
  event,
  onClose,
  onFilter,
}: {
  x: number;
  y: number;
  event: RealtimeEvent;
  onClose: () => void;
  onFilter: (value: string) => void;
}) {
  const copy = useCopy();

  return (
    <ContextMenu
      x={x}
      y={y}
      onClose={onClose}
      items={[
        { label: 'Filter by this event', icon: <Filter size={13} />, action: () => onFilter(event.event) },
        { label: 'Filter by this channel', icon: <Filter size={13} />, action: () => onFilter(event.channel) },
        { type: 'separator' as const },
        {
          label: 'Copy payload',
          icon: <Copy size={13} />,
          action: () => copy(JSON.stringify(event.payload, null, 2), 'Payload copied'),
        },
        {
          label: 'Copy as JSON',
          icon: <Copy size={13} />,
          action: () => copy(JSON.stringify(event, null, 2), 'JSON copied'),
        },
      ]}
    />
  );
}
