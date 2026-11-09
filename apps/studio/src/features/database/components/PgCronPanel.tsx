'use client';

import { AlertCircle, Edit2, Plus, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { EmptyState } from '@/shared/ui/EmptyState';
import { QueryState, type QueryLike } from '@/shared/ui/QueryState';
import { WriteButton } from '@/shared/ui/WriteButton';
import type { PgCronJob, PgCronJobsResponse } from '@/features/database/types';

/** Shown when the database has no pg_cron extension, with the one-click install. */
function ExtensionMissingNotice({ onEnable, enabling }: { onEnable: () => void; enabling: boolean }) {
  return (
    <div className="card flex items-start gap-3 p-4">
      <AlertCircle size={16} style={{ color: 'var(--yellow)', flexShrink: 0, marginTop: 1 }} />
      <div className="space-y-2">
        <p className="text-[13px]" style={{ color: 'var(--text)' }}>
          pg_cron extension is not installed.
        </p>
        <WriteButton onClick={onEnable} disabled={enabling} className="btn btn-primary">
          {enabling ? 'Enabling…' : 'Enable pg_cron'}
        </WriteButton>
        <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
          Or run it yourself: <code className="mono">CREATE EXTENSION pg_cron;</code> (requires superuser). If the
          button fails with "extension control file ... No such file or directory", this project's database container
          was built before pg_cron was added to the Postgres image. Rebuild images with{' '}
          <code className="mono">deploy/build-images.sh</code> and recreate the project's containers to pick up the new
          image.
        </p>
      </div>
    </div>
  );
}

function PgCronJobCard({
  job,
  onToggle,
  onEdit,
  onDelete,
  onOpenHistory,
  onContextMenu,
}: {
  job: PgCronJob;
  onToggle: (job: PgCronJob) => void;
  onEdit: (job: PgCronJob) => void;
  onDelete: (job: PgCronJob) => void;
  onOpenHistory: (job: PgCronJob) => void;
  onContextMenu: (event: React.MouseEvent, job: PgCronJob) => void;
}) {
  return (
    <div className="card flex flex-wrap items-start gap-4 p-4" onContextMenu={e => onContextMenu(e, job)}>
      <div className="flex items-center gap-3">
        <button onClick={() => onToggle(job)} title={job.active ? 'Disable' : 'Enable'}>
          {job.active ? (
            <ToggleRight size={26} style={{ color: 'var(--green)' }} />
          ) : (
            <ToggleLeft size={26} style={{ color: 'var(--text-mute)' }} />
          )}
        </button>
        <button onClick={() => onOpenHistory(job)} className="text-left" title="Run history">
          <div className="text-[14px] font-medium hover:underline">{job.jobname}</div>
          <div className="mono mt-0.5 text-[11px]" style={{ color: 'var(--text-mute)' }}>
            {job.database} · {job.username}
          </div>
        </button>
      </div>

      <span className="chip mono">{job.schedule}</span>

      <div className="min-w-0 flex-1">
        <code className="block truncate text-[11px]" style={{ color: 'var(--text-dim)' }}>
          {job.command}
        </code>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <button onClick={() => onEdit(job)} className="btn btn-ghost" title="Edit job">
          <Edit2 size={12} />
        </button>
        <button
          onClick={() => onDelete(job)}
          className="btn btn-ghost"
          style={{ color: 'var(--danger)' }}
          title="Delete job"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

/**
 * @param query the query itself, not its unwrapped data.
 *
 * `jobs={data ?? []}` is what made a failed request render as "No cron jobs
 * yet": a request that never answered looked exactly like a database with no
 * schedules in it. QueryState tells the two apart, and keeps the last good list
 * on screen with a notice when a refresh fails.
 */
export function PgCronPanel({
  query,
  onEnableExtension,
  enablingExtension,
  onCreate,
  onToggle,
  onEdit,
  onDelete,
  onOpenHistory,
  onContextMenu,
}: {
  query: QueryLike<PgCronJobsResponse>;
  onEnableExtension: () => void;
  enablingExtension: boolean;
  onCreate: () => void;
  onToggle: (job: PgCronJob) => void;
  onEdit: (job: PgCronJob) => void;
  onDelete: (job: PgCronJob) => void;
  onOpenHistory: (job: PgCronJob) => void;
  onContextMenu: (event: React.MouseEvent, job: PgCronJob) => void;
}) {
  return (
    <div className="space-y-4">
      <QueryState
        query={query}
        isEmpty={data => !data.extensionMissing && data.jobs.length === 0}
        errorTitle="Could not load cron jobs"
        empty={
          <div className="card">
            <EmptyState
              size="md"
              mascot="sleeping"
              title="No cron jobs yet"
              description="Schedule recurring SQL commands using standard cron expressions."
              action={
                <WriteButton onClick={onCreate} className="btn btn-primary">
                  <Plus size={12} /> New job
                </WriteButton>
              }
            />
          </div>
        }
      >
        {data =>
          data.extensionMissing ? (
            <ExtensionMissingNotice onEnable={onEnableExtension} enabling={enablingExtension} />
          ) : (
            <div className="grid gap-3 rise-stagger">
              {data.jobs.map(job => (
                <PgCronJobCard
                  key={job.jobid}
                  job={job}
                  onToggle={onToggle}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onOpenHistory={onOpenHistory}
                  onContextMenu={onContextMenu}
                />
              ))}
            </div>
          )
        }
      </QueryState>
    </div>
  );
}
