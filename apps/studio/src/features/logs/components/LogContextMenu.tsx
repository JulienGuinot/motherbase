'use client';

import { Copy, Filter, Hash } from 'lucide-react';
import { ContextMenu, type MenuItem } from '@/shared/ui/ContextMenu';
import { useCopy } from '@/shared/hooks/useCopy';
import type { LogLike } from '@/features/logs/lib/log-stream';

/** Right-click on a log line: copy it, or filter the stream by one of its fields. */
export function LogContextMenu<T extends LogLike>({
  x,
  y,
  entry,
  entryId,
  facetActions,
  hasFilters,
  onClose,
  onFilterLevel,
  onClearFilters,
}: {
  x: number;
  y: number;
  entry: T;
  entryId: string;
  /** One "filter by X" entry per extra facet, in display order. */
  facetActions: { label: string; run: () => void }[];
  hasFilters: boolean;
  onClose: () => void;
  onFilterLevel: () => void;
  onClearFilters: () => void;
}) {
  const copy = useCopy();

  const items: MenuItem[] = [
    { label: 'Copy message', icon: <Copy size={13} />, action: () => copy(entry.message, 'Message copied') },
    {
      label: 'Copy as JSON',
      icon: <Copy size={13} />,
      action: () => copy(JSON.stringify(entry, null, 2), 'JSON copied'),
    },
    { label: 'Copy entry ID', icon: <Hash size={13} />, action: () => copy(entryId, 'ID copied') },
    { type: 'separator' as const },
    ...facetActions.map(action => ({ label: action.label, icon: <Filter size={13} />, action: action.run })),
    { label: `Filter by level: ${entry.level}`, icon: <Filter size={13} />, action: onFilterLevel },
    { type: 'separator' as const },
    { label: 'Clear filters', icon: <Filter size={13} />, disabled: !hasFilters, action: onClearFilters },
  ];

  return <ContextMenu x={x} y={y} onClose={onClose} items={items} />;
}
