'use client';

import { Copy, Edit3, Hash, Trash2 } from 'lucide-react';
import { ContextMenu } from '@/shared/ui/ContextMenu';
import { useCopy } from '@/shared/hooks/useCopy';
import type { FnInfo } from '@/features/database/types';

export function FunctionContextMenu({
  x,
  y,
  fn,
  onClose,
  onOpen,
  onDrop,
}: {
  x: number;
  y: number;
  fn: FnInfo;
  onClose: () => void;
  onOpen: (fn: FnInfo) => void;
  onDrop: (fn: FnInfo) => void;
}) {
  const copy = useCopy();

  return (
    <ContextMenu
      x={x}
      y={y}
      onClose={onClose}
      items={[
        { label: 'Open', icon: <Edit3 size={13} />, action: () => onOpen(fn) },
        { type: 'separator' as const },
        { label: 'Copy name', icon: <Hash size={13} />, action: () => copy(fn.name, 'Name copied') },
        { label: 'Copy definition', icon: <Copy size={13} />, action: () => copy(fn.definition, 'Definition copied') },
        { type: 'separator' as const },
        { label: 'Drop function', icon: <Trash2 size={13} />, danger: true, action: () => onDrop(fn) },
      ]}
    />
  );
}
