'use client';

import { Copy, Edit2, Hash, Send, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { ContextMenu } from '@/shared/ui/ContextMenu';
import { useCopy } from '@/shared/hooks/useCopy';
import type { Hook } from '@/features/database/types';

/** Right-click actions on a webhook. Same operations as the row buttons. */
export function WebhookContextMenu({
  x,
  y,
  hook,
  onClose,
  onEdit,
  onToggle,
  onTest,
  onDelete,
}: {
  x: number;
  y: number;
  hook: Hook;
  onClose: () => void;
  onEdit: (hook: Hook) => void;
  onToggle: (hook: Hook) => void;
  onTest: (id: string) => void;
  onDelete: (hook: Hook) => void;
}) {
  const copy = useCopy();

  return (
    <ContextMenu
      x={x}
      y={y}
      onClose={onClose}
      items={[
        { label: 'Edit webhook', icon: <Edit2 size={13} />, action: () => onEdit(hook) },
        {
          label: hook.enabled ? 'Disable' : 'Enable',
          icon: hook.enabled ? <ToggleLeft size={13} /> : <ToggleRight size={13} />,
          action: () => onToggle(hook),
        },
        { label: 'Send test payload', icon: <Send size={13} />, action: () => onTest(hook.id) },
        { type: 'separator' as const },
        { label: 'Copy URL', icon: <Copy size={13} />, action: () => copy(hook.url, 'URL copied') },
        { label: 'Copy webhook ID', icon: <Hash size={13} />, action: () => copy(hook.id, 'ID copied') },
        {
          label: 'Copy as JSON',
          icon: <Copy size={13} />,
          action: () => copy(JSON.stringify(hook, null, 2), 'JSON copied'),
        },
        { type: 'separator' as const },
        { label: 'Delete webhook', icon: <Trash2 size={13} />, danger: true, action: () => onDelete(hook) },
      ]}
    />
  );
}
