'use client';

import { Circle, Cpu, ExternalLink, Gauge, HardDrive, MemoryStick, Play, RotateCw, Settings, Square, Terminal } from 'lucide-react';
import { formatBytes } from '@/shared/lib/format';
import { Skeleton } from '@/shared/ui/Skeleton';
import { UsageMeter } from '@/features/projects/components/UsageMeter';
import type { ProjectSummary, ProjectUsage } from '@/features/projects/types';
import type { ProjectDisk } from '@/shared/lib/api';

const ACTION_CLASS = 'btn btn-ghost flex items-center gap-1.5 border hairline px-3 py-1.5 text-xs disabled:opacity-40';

function CardAction({ label, ...rest }: { label: string } & React.ComponentProps<'button'>) {
  return <button {...rest} className={ACTION_CLASS} title={label} aria-label={label} />;
}

/** Live CPU and memory against the project's quota, when it has one. */
function UsagePanel({ usage }: { usage: ProjectUsage }) {
  return (
    <div className="space-y-2.5">
      <UsageMeter
        icon={Cpu}
        label="CPU"
        percent={usage.cpuLimit ? usage.cpuPct ?? 0 : Math.min(100, usage.cpuPercent)}
        value={`${usage.cpuPercent.toFixed(1)}%`}
        limit={usage.cpuLimit ? `${usage.cpuLimit} core${usage.cpuLimit === 1 ? '' : 's'}` : 'default'}
        hasQuota={usage.cpuLimit != null}
      />
      <UsageMeter
        icon={MemoryStick}
        label="Memory"
        percent={usage.memLimitBytes ? usage.memPct ?? 0 : Math.min(100, usage.memPercent)}
        value={formatBytes(usage.memUsed)}
        limit={usage.memLimitBytes ? formatBytes(usage.memLimitBytes) : 'default'}
        hasQuota={usage.memLimitBytes != null}
      />
    </div>
  );
}

/** Same shape as UsagePanel, held while the metrics poll is still in flight. */
function UsageSkeleton() {
  return (
    <div className="space-y-2.5" aria-busy>
      {[
        { Icon: Cpu, label: 'CPU' },
        { Icon: MemoryStick, label: 'Memory' },
      ].map(({ Icon, label }) => (
        <div key={label}>
          <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--text-mute)' }}>
            <span className="flex items-center gap-1.5">
              <Icon size={11} /> {label}
            </span>
            <Skeleton style={{ height: 9, width: 72, borderRadius: 3 }} />
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden" style={{ background: 'var(--surface-2)', borderRadius: 999 }}>
            <Skeleton style={{ height: '100%', width: '38%', borderRadius: 999 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ProjectCard({
  project,
  usage,
  usagePending,
  disk,
  diskTotal,
  busyAction,
  canManageRuntime,
  canWriteSettings,
  onOpen,
  onStart,
  onStop,
  onRestart,
  onCopyShell,
  onOpenResources,
  onOpenSettings,
}: {
  project: ProjectSummary;
  usage?: ProjectUsage;
  usagePending?: boolean;
  /** This project's volumes on disk, and the server disk size to scale them against when it has no quota. */
  disk?: ProjectDisk;
  diskTotal?: number;
  busyAction?: string;
  canManageRuntime: boolean;
  canWriteSettings: boolean;
  onOpen: (project: ProjectSummary) => void;
  onStart: (name: string) => void;
  onStop: (name: string) => void;
  onRestart: (name: string) => void;
  onCopyShell: (name: string) => void;
  onOpenResources: (project: ProjectSummary) => void;
  onOpenSettings: (project: ProjectSummary) => void;
}) {
  const running = project.status === 'running';
  const busy = Boolean(busyAction);

  return (
    <div className="card flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="mb-4 min-w-0">
          <div className="flex items-center gap-2">
            <Circle size={8} fill={running ? 'var(--green)' : 'var(--text-mute)'} stroke="none" />
            <span className="truncate text-[13px]" style={{ color: 'var(--text)', fontWeight: 500 }}>
              {project.name}
            </span>
          </div>
          <div className="mt-1 truncate text-[12px]" style={{ color: 'var(--text-mute)' }}>
            {project.domain}
          </div>
        </div>
        <span className="chip shrink-0" style={{ color: running ? 'var(--green)' : 'var(--text-mute)' }}>
          {running ? 'Running' : 'Stopped'}
        </span>
      </div>

      {running && (usage ? <UsagePanel usage={usage} /> : usagePending ? <UsageSkeleton /> : null)}

      {disk && (
        <div title={disk.volumes.map(v => `${v.label} ${formatBytes(v.size)}`).join(' · ')}>
          <UsageMeter
            icon={HardDrive}
            label="Disk"
            percent={disk.quota ? (disk.size / disk.quota) * 100 : diskTotal ? (disk.size / diskTotal) * 100 : 0}
            value={formatBytes(disk.size)}
            limit={disk.quota ? `${formatBytes(disk.quota)} quota` : diskTotal ? `${formatBytes(diskTotal)} server` : 'server'}
            hasQuota={disk.quota != null}
          />
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <CardAction label="Open project" onClick={() => onOpen(project)}>
          <ExternalLink size={12} />
        </CardAction>

        {canManageRuntime && (
          <>
            {running ? (
              <CardAction label="Stop" disabled={busy} onClick={() => onStop(project.name)}>
                <Square size={12} />
              </CardAction>
            ) : (
              <CardAction label="Start" disabled={busy} onClick={() => onStart(project.name)}>
                <Play size={12} />
              </CardAction>
            )}
            <CardAction label="Restart" disabled={busy} onClick={() => onRestart(project.name)}>
              <RotateCw size={12} />
            </CardAction>
            <CardAction label="Copy project shell command" disabled={busy} onClick={() => onCopyShell(project.name)}>
              <Terminal size={12} />
            </CardAction>
          </>
        )}

        {canWriteSettings && (
          <>
            <CardAction label="Resource quotas and usage" disabled={busy} onClick={() => onOpenResources(project)}>
              <Gauge size={12} />
            </CardAction>
            <CardAction label="Project configuration" disabled={busy} onClick={() => onOpenSettings(project)}>
              <Settings size={12} />
            </CardAction>
          </>
        )}
      </div>
    </div>
  );
}
