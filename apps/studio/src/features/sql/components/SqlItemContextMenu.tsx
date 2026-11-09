'use client';

import { Copy, Plus, Trash2 } from 'lucide-react';
import { ContextMenu } from '@/shared/ui/ContextMenu';
import { useCopy } from '@/shared/hooks/useCopy';

/**
 * Right-click actions on a saved snippet or a history entry. Both hold a piece
 * of SQL and support the same three things, so they share one menu.
 */
export function SqlItemContextMenu({
  x,
  y,
  sql,
  deleteLabel,
  onClose,
  onOpen,
  onDelete,
}: {
  x: number;
  y: number;
  sql: string;
  deleteLabel: string;
  onClose: () => void;
  onOpen: (sql: string) => void;
  onDelete: () => void;
}) {
  const copy = useCopy();

  return (
    <ContextMenu
      x={x}
      y={y}
      onClose={onClose}
      items={[
        { label: 'Open in new tab', icon: <Plus size={13} />, action: () => onOpen(sql) },
        { label: 'Copy SQL', icon: <Copy size={13} />, action: () => copy(sql, 'Copied') },
        { type: 'separator' as const },
        { label: deleteLabel, danger: true, icon: <Trash2 size={13} />, action: onDelete },
      ]}
    />
  );
}
