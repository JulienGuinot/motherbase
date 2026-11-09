'use client';

import { FileCode, GitCompare, Play, Plus, RotateCcw, Wrench } from 'lucide-react';
import { EmptyState } from '@/shared/ui/EmptyState';
import { SkeletonList } from '@/shared/ui/Skeleton';
import { WriteButton } from '@/shared/ui/WriteButton';
import { OriginBadge, StatusBadge } from '@/features/database/components/MigrationStatusBadge';
import type { MigrationRow } from '@/features/database/types';

export function MigrationList({
  migrations,
  isLoading,
  onOpen,
  onApply,
  onRollback,
  onRepair,
  onNew,
  onDiff,
  applying,
  rollingBack,
  repairing,
  diffing,
}: {
  migrations: MigrationRow[];
  isLoading: boolean;
  onOpen: (id: string) => void;
  onApply: (id: string, name: string) => void;
  onRollback: (id: string, name: string) => void;
  onRepair: (version: string, status: 'applied' | 'reverted', name: string) => void;
  onNew: () => void;
  onDiff: () => void;
  applying: boolean;
  rollingBack: boolean;
  repairing: boolean;
  diffing: boolean;
}) {
  if (isLoading) return <SkeletonList rows={3} className="card p-4" />;

  if (migrations.length === 0) {
    return (
      <div className="card">
        <EmptyState
          size="md"
          mascot="update"
          title="No migrations yet"
          description="Author a migration by hand, or generate a starting point by diffing the live schema against the last snapshot."
          action={
            <div className="flex gap-2">
              <button onClick={onDiff} disabled={diffing} className="btn">
                <GitCompare size={12} /> Diff from live
              </button>
              <WriteButton onClick={onNew} className="btn btn-primary">
                <Plus size={12} /> New migration
              </WriteButton>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="grid gap-3 rise-stagger">
      {migrations.map(migration => {
        const applied = migration.status === 'applied';
        return (
          <div key={migration.id} className="card flex flex-wrap items-center gap-4 p-4">
            <button onClick={() => onOpen(migration.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
              <FileCode size={16} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
              <div className="min-w-0">
                <div className="truncate text-[13px]">
                  <span className="mono" style={{ color: 'var(--text-mute)' }}>{migration.version}</span>{' '}
                  <span className="mono">{migration.name}</span>
                </div>
                <div className="mono mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-mute)' }}>
                  {applied && migration.appliedAt
                    ? `applied ${new Date(migration.appliedAt).toLocaleString()}`
                    : `created ${new Date(migration.createdAt).toLocaleString()}`}
                </div>
              </div>
            </button>

            <OriginBadge origin={migration.origin} />
            <StatusBadge status={migration.status} />

            <div className="flex items-center gap-1">
              <button
                onClick={() => onApply(migration.id, migration.name)}
                className="btn btn-ghost"
                disabled={applied || applying}
                title={applied ? 'Already applied' : 'Apply migration'}
              >
                <Play size={12} /> Apply
              </button>
              <button
                onClick={() => onRollback(migration.id, migration.name)}
                className="btn btn-ghost"
                style={{ color: 'var(--danger)' }}
                disabled={!applied || rollingBack}
                title={applied ? 'Roll back migration' : 'Only applied migrations can be rolled back'}
              >
                <RotateCcw size={12} /> Roll back
              </button>
              <button
                onClick={() => onRepair(migration.version, applied ? 'reverted' : 'applied', migration.name)}
                className="btn btn-ghost"
                disabled={repairing}
                title={applied
                  ? 'Mark as not applied, without running the down SQL'
                  : 'Mark as applied, without running it (the database already has this change)'}
              >
                <Wrench size={12} /> {applied ? 'Mark reverted' : 'Mark applied'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
