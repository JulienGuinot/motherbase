'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Activity, Clock, ExternalLink, FileCode2, Play } from 'lucide-react';
import DetailDrawer, { type DrawerTab } from '@/shared/ui/DetailDrawer';
import { CodeBlock } from '@/shared/ui/CodeBlock';
import { EmptyState } from '@/shared/ui/EmptyState';
import { QueryState } from '@/shared/ui/QueryState';
import { WriteButton } from '@/shared/ui/WriteButton';
import { formatRelativeTime } from '@/shared/lib/format';
import { getErrorMessage } from '@/shared/lib/errors';
import { projectPath } from '@/shared/lib/project';
import { useToast } from '@/shared/lib/toast';
import CronScheduleField from '@/features/api-tools/components/CronScheduleField';
import { describeCron } from '@/features/api-tools/lib/cron-schedule';
import { useAppJobRuns, useConfigureAppJob, useRunAppJob } from '@/features/database/hooks/useCron';
import type { AppJob, AppJobRun } from '@/features/database/types';

const KIND_LABEL: Record<AppJob['kind'], string> = {
  app: 'Registered in application code',
  edge: 'Scheduled edge function',
  platform: 'Platform scheduler',
};

/**
 * One app job: what it is, what it did, and the two things an operator wants to
 * do to it.
 *
 * The drawer used to be a list of run timestamps. It could not say what the job
 * does when it fires, could not force a run to find out, and showed nothing at
 * all for a successful run, so a storage cleanup that removed 40,000 objects
 * and one that removed none were the same green row. The definition comes from
 * the scheduler that owns the job, the output from the ledger, and the cadence
 * is editable exactly where it is data rather than a constant in code.
 */
export function AppJobRunDrawer({ job, onClose }: { job: AppJob; onClose: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState('definition');
  const runsQuery = useAppJobRuns(job.id);
  const runM = useRunAppJob(job.id);
  const configureM = useConfigureAppJob(job.id);

  const tabs: DrawerTab[] = [
    { id: 'definition', label: 'Definition', icon: FileCode2 },
    { id: 'runs', label: `Run history${job.runs ? ` (${job.runs})` : ''}`, icon: Activity },
  ];

  // `/jobs` is rated `runtime.manage` by the console proxy, so the buttons have
  // to ask for that capability: defaulting to `content.write` would offer a run
  // the server then refuses, which reads as a bug rather than as a permission.
  const runNow = async () => {
    try {
      await runM.mutateAsync();
      // The history is where the outcome actually lands, so send them there.
      setTab('runs');
      toast.push({ kind: 'success', title: `Ran ${job.name}`, message: 'Recorded in the run history below.' });
    } catch (error) {
      toast.push({ kind: 'error', title: `${job.name} failed`, message: getErrorMessage(error) });
    }
  };

  const saveSchedule = async (next: string) => {
    const schedule = next.trim() || null;
    if (schedule === (job.schedule ?? null)) return;
    try {
      await configureM.mutateAsync({ schedule });
      toast.push({ kind: 'success', title: schedule ? 'Schedule updated' : 'Schedule cleared' });
    } catch (error) {
      toast.push({ kind: 'error', title: 'Could not change the schedule', message: getErrorMessage(error) });
    }
  };

  const toggleEnabled = async () => {
    try {
      await configureM.mutateAsync({ enabled: !job.enabled });
      toast.push({ kind: 'success', title: job.enabled ? 'Job disarmed' : 'Job armed' });
    } catch (error) {
      toast.push({ kind: 'error', title: 'Could not change the job', message: getErrorMessage(error) });
    }
  };

  const avatar = (
    <div
      className="flex h-11 w-11 shrink-0 items-center justify-center"
      style={{
        background: 'var(--surface-2)',
        color: job.enabled ? 'var(--green)' : 'var(--text-mute)',
        borderRadius: 999,
      }}
    >
      <Clock size={18} />
    </div>
  );

  const footer = (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
        {job.runnable
          ? 'Runs the same code path the timer does, recorded as a manual run.'
          : 'This job cannot be forced from the console.'}
      </span>
      <WriteButton
        capability="runtime.manage"
        className="btn btn-primary flex items-center gap-1.5"
        disabled={!job.runnable || runM.isPending}
        onClick={runNow}
        title={job.runnable ? 'Run this job now' : 'This job cannot be run on demand'}
      >
        <Play size={13} />
        {runM.isPending ? 'Running…' : 'Run now'}
      </WriteButton>
    </div>
  );

  return (
    <DetailDrawer
      title={job.name}
      subtitle={<span className="mono">{job.schedule ?? job.id}</span>}
      avatar={avatar}
      tabs={tabs}
      activeTab={tab}
      onTab={setTab}
      onClose={onClose}
      footer={footer}
      width="38rem"
    >
      {tab === 'definition' ? (
        <DefinitionTab
          job={job}
          busy={configureM.isPending}
          onSchedule={saveSchedule}
          onToggle={toggleEnabled}
        />
      ) : (
        <div className="space-y-2">
          <div className="label">Recent runs</div>
          <QueryState
            query={runsQuery}
            skeletonRows={4}
            skeletonClassName=""
            errorTitle="Could not load run history"
            empty={
              <EmptyState
                title="No runs recorded yet"
                description={
                  job.state === 'scheduled'
                    ? 'The schedule is armed. The first entry appears after its next fire, or run it now from the bottom of this panel.'
                    : 'Nothing has been recorded for this job. Run it now to find out what it does.'
                }
              />
            }
          >
            {runs => runs.map(run => <RunRow key={run.id} run={run} />)}
          </QueryState>
        </div>
      )}
    </DetailDrawer>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="mt-1 text-[12.5px]" style={{ color: 'var(--text)' }}>
        {children}
      </div>
    </div>
  );
}

function DefinitionTab({
  job,
  busy,
  onSchedule,
  onToggle,
}: {
  job: AppJob;
  busy: boolean;
  onSchedule: (next: string) => void;
  onToggle: () => void;
}) {
  return (
    <div className="space-y-4">
      <Field label="What it does">
        <span style={{ color: 'var(--text-dim)' }}>{job.definition.does}</span>
      </Field>

      <Field label="Kind">{KIND_LABEL[job.kind]}</Field>

      <Field label="Defined in">
        <span className="mono text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
          {job.definition.source}
        </span>
      </Field>

      <Field label="Schedule">
        {job.configurable ? (
          // Editable only where the cadence is data. Everywhere else an input
          // here could do nothing but 400 on save.
          <div className="flex flex-wrap items-center gap-2">
            <CronScheduleField value={job.schedule ?? ''} onChange={onSchedule} />
            <WriteButton capability="runtime.manage" className="btn" disabled={busy} onClick={onToggle}>
              {job.enabled ? 'Disarm' : 'Arm'}
            </WriteButton>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="chip mono">{job.schedule ?? 'no cadence declared'}</span>
            {job.schedule && isCron(job.schedule) && (
              <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
                {describeCron(job.schedule)}
              </span>
            )}
          </div>
        )}
      </Field>

      {job.definition.settingsHref && (
        <Link
          href={projectPath(job.definition.settingsHref)}
          className="inline-flex items-center gap-1.5 text-[12px]"
          style={{ color: 'var(--accent)' }}
        >
          <ExternalLink size={12} />
          {job.configurable ? 'Open its editor' : 'Open the settings that control it'}
        </Link>
      )}

      <div className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
        Ledger key <span className="mono" style={{ color: 'var(--text)' }}>{job.id}</span>
        {job.medianIntervalMs != null && (
          <> · observed every ~{Math.max(1, Math.round(job.medianIntervalMs / 60_000))} min</>
        )}
        {job.nextRunAt && <> · next {formatRelativeTime(job.nextRunAt)}</>}
      </div>
    </div>
  );
}

/** A 5-field cron expression, as opposed to a prose cadence like "polls every 5s". */
function isCron(schedule: string): boolean {
  return schedule.trim().split(/\s+/).length === 5;
}

function durationOf(run: AppJobRun): string {
  if (!run.finishedAt) return run.status === 'running' ? 'in flight' : '—';
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  return ms >= 0 ? `${ms}ms` : '—';
}

function RunRow({ run }: { run: AppJobRun }) {
  const color =
    run.status === 'ok' ? 'var(--green)' : run.status === 'failed' ? 'var(--danger)' : 'var(--blue)';

  return (
    <div className="border hairline p-3" style={{ borderRadius: 'var(--radius-sm)' }}>
      <div className="flex items-start gap-3">
        <span className="chip" style={{ color }}>
          {run.status}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            {formatRelativeTime(run.startedAt)}
            {run.trigger === 'manual' && (
              // A forced run is not evidence the timer fired, and reading it as
              // one is how a dead schedule stays invisible.
              <span className="chip" style={{ color: 'var(--amber)' }} title="Started by an operator, not by the timer">
                manual
              </span>
            )}
          </div>
        </div>
        <span className="mono text-[11px]" style={{ color: 'var(--text-mute)' }}>
          {durationOf(run)}
        </span>
      </div>

      {run.error && (
        <CodeBlock className="mt-2" value={run.error} tone="danger" size="sm" wrap label="Error" />
      )}
      {run.output && <CodeBlock className="mt-2" value={run.output} size="sm" wrap label="Output" />}
    </div>
  );
}
