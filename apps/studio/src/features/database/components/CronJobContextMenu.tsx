'use client';

import { Copy, Edit2, Hash, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { ContextMenu } from '@/shared/ui/ContextMenu';
import { useCopy } from '@/shared/hooks/useCopy';
import type { PgCronJob } from '@/features/database/types';

/** Right-click actions on a pg_cron job. Same operations as the card buttons. */
export function CronJobContextMenu({
  x,
  y,
  job,
  onClose,
  onEdit,
  onToggle,
  onDelete,
}: {
  x: number;
  y: number;
  job: PgCronJob;
  onClose: () => void;
  onEdit: (job: PgCronJob) => void;
  onToggle: (job: PgCronJob) => void;
  onDelete: (job: PgCronJob) => void;
}) {
  const copy = useCopy();

  return (
    <ContextMenu
      x={x}
      y={y}
      onClose={onClose}
      items={[
        { label: 'Edit job', icon: <Edit2 size={13} />, action: () => onEdit(job) },
        {
          label: job.active ? 'Disable' : 'Enable',
          icon: job.active ? <ToggleLeft size={13} /> : <ToggleRight size={13} />,
          action: () => onToggle(job),
        },
        { type: 'separator' as const },
        { label: 'Copy name', icon: <Hash size={13} />, action: () => copy(job.jobname, 'Name copied') },
        { label: 'Copy command', icon: <Copy size={13} />, action: () => copy(job.command, 'Command copied') },
        { type: 'separator' as const },
        { label: 'Delete job', icon: <Trash2 size={13} />, danger: true, action: () => onDelete(job) },
      ]}
    />
  );
}
