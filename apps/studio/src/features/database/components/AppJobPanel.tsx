'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { EmptyState } from '@/shared/ui/EmptyState';
import { QueryState, type QueryLike } from '@/shared/ui/QueryState';
import { formatRelativeTime } from '@/shared/lib/format';
import { JobStatusIcon } from '@/features/database/components/JobStatusIcon';
import { AppJobRunDrawer } from '@/features/database/components/AppJobRunDrawer';
import type { AppJob, AppJobState } from '@/features/database/types';

/** Wording for each state, so "we do not know" never reads as "fine". */
const STATE_LABEL: Record<AppJobState, string> = {
  disabled: 'Disabled',
  scheduled: 'Scheduled, not run yet',
  running: 'Running now',
  ok: 'Last run succeeded',
  failed: 'Last run failed',
  unknown: 'History unavailable',
};

const STATE_COLOR: Record<AppJobState, string> = {
  disabled: 'var(--text-mute)',
  scheduled: 'var(--blue)',
  running: 'var(--blue)',
  ok: 'var(--green)',
  failed: 'var(--danger)',
  unknown: 'var(--amber)',
};

const KIND_LABEL: Record<AppJob['kind'], string> = {
  app: 'code',
  edge: 'edge function',
  platform: 'platform',
};

/**
 * Application-level jobs: scheduled edge functions, code-registered jobs and
 * the platform's own schedulers.
 *
 * Every row is now a declared job joined to its run history on a stable id, so
 * a scheduled function appears once rather than twice (once under its name and
 * once as `edge:<id>` labelled "platform"), and a scheduler that is configured
 * but has never fired appears at all. Clicking a row opens its recorded runs:
 * `/jobs/runs` has always existed and nothing here called it, so a failing job
 * showed one truncated error and no history.
 */
export function AppJobPanel({ query }: { query: QueryLike<{ jobs: AppJob[]; partial: boolean }> }) {
  const [openJob, setOpenJob] = useState<AppJob | null>(null);

  return (
    <>
      <QueryState
        query={query}
        isEmpty={data => data.jobs.length === 0}
        errorTitle="Could not load app jobs"
        empty={
          <div className="card">
            <EmptyState
              size="md"
              mascot="sleeping"
              title="No app jobs registered"
              description={
                <>
                  Nothing on a timer yet. Give an <strong>edge function</strong> a schedule (from its editor, next
                  to its route) to run it on a timer from the dashboard. It shows up here with live run status.
                  Core system jobs can also be registered in code via{' '}
                  <code className="mono">helpers/cron.helper.ts</code>. For anything expressible as SQL, the{' '}
                  <strong>pg_cron</strong> tab is usually simpler.
                </>
              }
            />
          </div>
        }
      >
        {data => (
          <div className="space-y-4">
            {data.partial && (
              <div
                className="flex items-center gap-3 border px-4 py-2.5"
                style={{
                  borderColor: 'color-mix(in srgb, var(--amber) 42%, transparent)',
                  background: 'color-mix(in srgb, var(--amber) 10%, var(--surface))',
                  borderRadius: 'var(--radius-md)',
                }}
                role="status"
              >
                <AlertTriangle size={15} style={{ color: 'var(--amber)', flexShrink: 0 }} />
                <span className="text-[12.5px]">
                  Run history is unavailable, so outcomes and last-run times are missing. The schedules below are
                  still accurate.
                </span>
              </div>
            )}

            <div className="grid gap-3 rise-stagger">
              {data.jobs.map(job => (
                <button
                  key={job.id}
                  type="button"
                  onClick={() => setOpenJob(job)}
                  className="card flex w-full flex-wrap items-center gap-4 p-4 text-left"
                  title="Show recorded runs"
                >
                  <JobStatusIcon status={job.lastStatus} state={job.state} />
                  <div className="min-w-0">
                    <div className="text-[14px] font-medium">{job.name}</div>
                    <div className="text-[11px]" style={{ color: STATE_COLOR[job.state] }}>
                      {STATE_LABEL[job.state]}
                    </div>
                  </div>

                  {job.schedule && <span className="chip mono">{job.schedule}</span>}
                  <span className="chip" style={{ color: 'var(--text-mute)' }}>
                    {KIND_LABEL[job.kind]}
                  </span>
                  {!job.declared && (
                    <span
                      className="chip"
                      style={{ color: 'var(--amber)' }}
                      title="Only seen in the run ledger: no scheduler in this process claims it. An old schedule, or one this instance did not start."
                    >
                      not scheduled here
                    </span>
                  )}

                  <div className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                    Last: <span style={{ color: 'var(--text)' }}>{formatRelativeTime(job.lastRunAt)}</span>
                  </div>
                  {job.nextRunAt && (
                    <div className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                      Next: <span style={{ color: 'var(--text)' }}>{formatRelativeTime(job.nextRunAt)}</span>
                    </div>
                  )}
                  {job.runs > 0 && (
                    <div className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                      {job.runs} recorded {job.runs === 1 ? 'run' : 'runs'}
                    </div>
                  )}

                  {job.lastStatus === 'error' && job.lastError && (
                    // Full width and wrapped, not truncated: the error is the
                    // one thing an operator opened this page for.
                    <div
                      className="mono w-full whitespace-pre-wrap break-words text-[11px]"
                      style={{ color: 'var(--danger)' }}
                    >
                      {job.lastError}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </QueryState>

      {openJob && <AppJobRunDrawer job={openJob} onClose={() => setOpenJob(null)} />}
    </>
  );
}
