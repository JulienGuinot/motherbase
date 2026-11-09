'use client';

import { Clock, Copy, Edit3, Hash, Link as LinkIcon, Play, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { ContextMenu } from '@/shared/ui/ContextMenu';
import { useCopy } from '@/shared/hooks/useCopy';
import type { EdgeFunctionTab } from '@/features/api-tools/components/EdgeFunctionWorkspace';
import type { EdgeFn } from '@/features/api-tools/types';

export function EdgeFunctionContextMenu({
  x,
  y,
  fn,
  invokeUrl,
  onClose,
  onOpen,
  onToggle,
  onDelete,
}: {
  x: number;
  y: number;
  fn: EdgeFn;
  invokeUrl: string;
  onClose: () => void;
  onOpen: (fn: EdgeFn, tab: EdgeFunctionTab) => void;
  onToggle: (fn: EdgeFn) => void;
  onDelete: (fn: EdgeFn) => void;
}) {
  const copy = useCopy();

  return (
    <ContextMenu
      x={x}
      y={y}
      onClose={onClose}
      items={[
        { label: 'Open', icon: <Edit3 size={13} />, action: () => onOpen(fn, 'editor') },
        { label: 'Run', icon: <Play size={13} />, action: () => onOpen(fn, 'invoke') },
        { label: 'View logs', icon: <Clock size={13} />, action: () => onOpen(fn, 'logs') },
        { type: 'separator' as const },
        {
          label: fn.enabled ? 'Disable' : 'Enable',
          icon: fn.enabled ? <ToggleLeft size={13} /> : <ToggleRight size={13} />,
          action: () => onToggle(fn),
        },
        { type: 'separator' as const },
        { label: 'Copy route', icon: <Copy size={13} />, action: () => copy(`/${fn.route}`, 'Route copied') },
        { label: 'Copy invoke URL', icon: <LinkIcon size={13} />, action: () => copy(invokeUrl, 'URL copied') },
        { label: 'Copy function ID', icon: <Hash size={13} />, action: () => copy(fn.id, 'ID copied') },
        { label: 'Copy code', icon: <Copy size={13} />, action: () => copy(fn.code, 'Code copied') },
        { type: 'separator' as const },
        { label: 'Delete function', icon: <Trash2 size={13} />, danger: true, action: () => onDelete(fn) },
      ]}
    />
  );
}
