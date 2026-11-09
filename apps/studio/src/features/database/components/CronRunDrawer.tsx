import { Clock, Activity } from 'lucide-react';
import DetailDrawer, { type DrawerTab } from '@/shared/ui/DetailDrawer';
import { useCronJobRuns } from '@/features/database/hooks/useCron';
import type { PgCronJob, CronRun } from '@/features/database/types';
import { EmptyState } from '@/shared/ui/EmptyState';
import { Labeled } from '@/shared/ui/Field';
import { CodeBlock } from '@/shared/ui/CodeBlock';
import { SkeletonList } from '@/shared/ui/Skeleton';

export function CronRunDrawer({ job, onClose }: { job: PgCronJob; onClose: () => void }) {
  const runsQ = useCronJobRuns(job.jobid);
  const runs = runsQ.data ?? [];

  const avatar = (
    <div className="flex h-11 w-11 shrink-0 items-center justify-center" style={{ background: 'var(--surface-2)', color: job.active ? 'var(--green)' : 'var(--text-mute)', borderRadius: 999 }}>
      <Clock size={18} />
    </div>
  );
  const tabs: DrawerTab[] = [{ id: 'runs', label: 'Run history', icon: Activity }];

  const durationOf = (r: CronRun): string => {
    if (!r.start_time || !r.end_time) return '—';
    const ms = new Date(r.end_time).getTime() - new Date(r.start_time).getTime();
    return ms >= 0 ? `${ms}ms` : '—';
  };
  const isOk = (s: string) => /succeeded/i.test(s);

  return (
    <DetailDrawer
      title={job.jobname}
      subtitle={<span className="mono">{job.schedule}</span>}
      avatar={avatar}
      tabs={tabs}
      activeTab="runs"
      onClose={onClose}
      width="34rem"
    >
      <div className="space-y-4">
        <Labeled label="Command">
          <CodeBlock value={job.command} label="SQL" language="sql" maxHeight={200} />
        </Labeled>
        <div className="space-y-2">
          <div className="label">Recent runs</div>
          {runsQ.isLoading && <SkeletonList rows={4} height={44} />}
          {!runsQ.isLoading && runs.length === 0 && (
            <EmptyState title="No runs recorded yet"
            description={<>pg_cron writes run history to <code className="mono">cron.job_run_details</code>; the first entry appears after the next scheduled fire.</>}
          />
          )}
          {runs.map(r => (
            <div key={r.runid} className="flex items-center gap-3 border hairline p-3" style={{ borderRadius: 'var(--radius-sm)' }}>
              <span
                className="chip shrink-0 capitalize"
                style={{ color: isOk(r.status) ? 'var(--green)' : 'var(--danger)', borderColor: isOk(r.status) ? 'var(--green)' : 'var(--danger)' }}
              >
                {r.status}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-mute)' }}>
                  <span className="inline-flex items-center gap-1"><Clock size={9} /> {r.start_time ? new Date(r.start_time).toLocaleString() : '—'}</span>
                  <span className="tabular-nums">{durationOf(r)}</span>
                </div>
                {r.return_message && (
                  <div className="mono mt-1 truncate text-[11px]" style={{ color: isOk(r.status) ? 'var(--text-dim)' : 'var(--danger)' }}>{r.return_message}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </DetailDrawer>
  );
}
