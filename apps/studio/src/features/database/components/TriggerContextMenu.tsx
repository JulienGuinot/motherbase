'use client';

import { Copy, Edit2, Hash, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { ContextMenu } from '@/shared/ui/ContextMenu';
import { useCopy } from '@/shared/hooks/useCopy';
import type { TriggerInfo } from '@/features/database/types';

/** Right-click actions on a trigger. Same operations as the card buttons. */
export function TriggerContextMenu({
  x,
  y,
  trigger,
  onClose,
  onEdit,
  onToggle,
  onDrop,
}: {
  x: number;
  y: number;
  trigger: TriggerInfo;
  onClose: () => void;
  onEdit: (trigger: TriggerInfo) => void;
  onToggle: (trigger: TriggerInfo) => void;
  onDrop: (trigger: TriggerInfo) => void;
}) {
  const copy = useCopy();

  return (
    <ContextMenu
      x={x}
      y={y}
      onClose={onClose}
      items={[
        { label: 'Edit trigger', icon: <Edit2 size={13} />, action: () => onEdit(trigger) },
        {
          label: trigger.enabled ? 'Disable' : 'Enable',
          icon: trigger.enabled ? <ToggleLeft size={13} /> : <ToggleRight size={13} />,
          action: () => onToggle(trigger),
        },
        { type: 'separator' as const },
        { label: 'Copy name', icon: <Hash size={13} />, action: () => copy(trigger.name, 'Name copied') },
        {
          label: 'Copy definition',
          icon: <Copy size={13} />,
          action: () => copy(trigger.definition, 'Definition copied'),
        },
        { type: 'separator' as const },
        { label: 'Drop trigger', icon: <Trash2 size={13} />, danger: true, action: () => onDrop(trigger) },
      ]}
    />
  );
}
