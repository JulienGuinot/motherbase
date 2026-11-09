import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive } from 'lucide-react';
import type { ProjectUsage } from '@/features/projects/types';
import { platform, type ProjectLimits } from '@/shared/lib/api';
import { getErrorMessage } from '@/shared/lib/errors';
import { formatBytes } from '@/shared/lib/format';
import { PROJECT_SERVICES } from '@/shared/lib/project-services';
import { useToast } from '@/shared/lib/toast';

const MIN_CPUS = 0.1;
const MIN_MEM_MB = 128;
const MIN_DISK_GB = 1;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

interface ResourceLimitsFormProps {
  project: string;
  usage?: ProjectUsage;
  onSaved?: () => void;
}

type Values = Record<keyof ProjectLimits, string>;

function toValues(data: ProjectLimits): Values {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value ?? '')])) as Values;
}

function invalid(value: string, min: number, wholeNumber = false): boolean {
  const n = Number(value);
  return !value || !Number.isFinite(n) || n < min || (wholeNumber && !Number.isInteger(n));
}

export function ResourceLimitsForm({ project, usage, onSaved }: ResourceLimitsFormProps) {
  const limitsQ = useQuery({
    queryKey: ['platform-project-limits', project],
    queryFn: () => platform.projectLimits(project),
  });

  if (limitsQ.isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3, 4].map(i => <div key={i} className="shimmer h-12 rounded-md" />)}
      </div>
    );
  }

  if (!limitsQ.data) return null;

  return (
    <LimitsEditor
      // Re-keyed on the loaded data instead of synced into state: a save
      // returns fresh values and remounts the form on them, while a plain
      // background refetch (same reference-unstable object) does not, so it
      // can never wipe what the operator is halfway through typing.
      key={JSON.stringify(limitsQ.data)}
      project={project}
      usage={usage}
      data={limitsQ.data}
      onSaved={onSaved}
    />
  );
}

/** A number input with its unit inside the box, so the figure never reads unitless. */
function UnitInput({ value, unit, step, min, bad, label, onChange }: {
  value: string;
  unit: string;
  step: number;
  min: number;
  bad: boolean;
  label: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative w-full sm:w-32">
      <input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        value={value}
        aria-label={label}
        aria-invalid={bad}
        onChange={e => onChange(e.target.value)}
        className="input tabular-nums"
        // Inline: the unlayered `.input` padding outranks a utility class.
        style={{ paddingRight: '3.25rem', borderColor: bad ? 'var(--red)' : undefined }}
      />
      <span
        className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px]"
        style={{ color: 'var(--text-mute)' }}
      >
        {unit}
      </span>
    </div>
  );
}

/** Pill bar against a capacity, amber then red as it fills. */
function Meter({ percent }: { percent: number }) {
  const color = percent >= 90 ? 'var(--red)' : percent >= 75 ? 'var(--amber)' : 'var(--accent)';
  return (
    <div className="h-1.5 w-full overflow-hidden" style={{ background: 'var(--surface-2)', borderRadius: 999 }}>
      <div className="h-full" style={{ width: `${Math.min(100, Math.max(1, percent))}%`, background: color, borderRadius: 999 }} />
    </div>
  );
}

function LimitsEditor({
  project,
  usage,
  data,
  onSaved,
}: {
  project: string;
  usage?: ProjectUsage;
  data: ProjectLimits;
  onSaved?: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [values, setValues] = useState<Values>(() => toValues(data));
  // Same keys as the fleet and monitor views, so this shares their polling.
  const metricsQ = useQuery({
    queryKey: ['platform-metrics'],
    queryFn: platform.metrics,
    refetchInterval: 5000,
  });
  const diskQ = useQuery({ queryKey: ['platform-disk'], queryFn: platform.disk, refetchInterval: 60_000 });

  const host = metricsQ.data?.host ?? null;
  const containers = (metricsQ.data?.containers ?? []).filter(c => c.project === project);
  const diskUsed = diskQ.data?.projects.find(p => p.project === project)?.size;

  const set = (key: keyof ProjectLimits) => (value: string) => setValues(prev => ({ ...prev, [key]: value }));
  const dirty = (Object.keys(values) as (keyof ProjectLimits)[]).some(key => Number(values[key]) !== data[key]);
  const diskBad = invalid(values.diskGb, MIN_DISK_GB, true);
  const formInvalid = diskBad || PROJECT_SERVICES.some(s => invalid(values[s.cpuKey], MIN_CPUS) || invalid(values[s.memKey], MIN_MEM_MB));

  const totalCpus = PROJECT_SERVICES.reduce((sum, s) => sum + (Number(values[s.cpuKey]) || 0), 0);
  const totalMemMb = PROJECT_SERVICES.reduce((sum, s) => sum + (Number(values[s.memKey]) || 0), 0);
  const diskGb = Number(values.diskGb) || 0;

  const save = useMutation({
    mutationFn: () => platform.setProjectLimits(
      project,
      Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Number(value)])) as Partial<ProjectLimits>,
    ),
    onSuccess: () => {
      toast.push({ kind: 'success', title: 'Quotas updated', message: 'Recreating the containers…' });
      // Refetches the loaded data the form is keyed on, so the remount that
      // clears "dirty" actually happens instead of leaving stale values shown
      // as unsaved.
      void qc.invalidateQueries({ queryKey: ['platform-project-limits', project] });
      // The disk cards show usage against this quota.
      void qc.invalidateQueries({ queryKey: ['platform-disk'] });
      onSaved?.();
    },
    onError: err => toast.push({ kind: 'error', title: 'Update failed', message: getErrorMessage(err) }),
  });

  return (
    <div className="space-y-5">
      {/* What the project is allowed in total, against what it uses and what the server has. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="flex items-baseline justify-between text-[12px]">
            <span style={{ color: 'var(--text-dim)' }}>CPU</span>
            <span className="tabular-nums" style={{ color: 'var(--text-mute)' }}>
              {totalCpus.toFixed(2)} cores{host ? ` of ${host.cpuCount}` : ''}
            </span>
          </div>
          <div className="mt-1.5"><Meter percent={usage?.cpuPct ?? 0} /></div>
          <div className="mt-1 text-[11px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
            {usage ? `${usage.cpuPct ?? 0}% of the quota in use` : 'Not running'}
          </div>
        </div>
        <div>
          <div className="flex items-baseline justify-between text-[12px]">
            <span style={{ color: 'var(--text-dim)' }}>Memory</span>
            <span className="tabular-nums" style={{ color: 'var(--text-mute)' }}>
              {formatBytes(totalMemMb * MIB)}{host ? ` of ${formatBytes(host.memTotal)}` : ''}
            </span>
          </div>
          <div className="mt-1.5"><Meter percent={usage?.memPct ?? 0} /></div>
          <div className="mt-1 text-[11px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
            {usage ? `${formatBytes(usage.memUsed)} in use · ${usage.memPct ?? 0}% of the quota` : 'Not running'}
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-md border hairline">
        <div
          className="hidden grid-cols-[1fr_8rem_8rem] gap-4 px-4 py-2 text-[11px] sm:grid"
          style={{ background: 'var(--surface-2)', color: 'var(--text-mute)' }}
        >
          <span>Service</span>
          <span>CPU</span>
          <span>Memory</span>
        </div>
        {PROJECT_SERVICES.map(s => {
          const live = containers.find(c => c.service === s.service);
          return (
            <div key={s.service} className="grid gap-3 border-t hairline px-4 py-3 sm:grid-cols-[1fr_8rem_8rem] sm:items-center sm:gap-4 [&:nth-child(2)]:border-t-0">
              <div className="min-w-0">
                <div className="text-[13px]" style={{ color: 'var(--text)' }}>{s.label}</div>
                <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-mute)' }}>{s.hint}</div>
                {live && (
                  <div className="mt-0.5 text-[11px] tabular-nums" style={{ color: 'var(--text-dim)' }}>
                    Now {live.cpuPercent.toFixed(1)}% CPU · {formatBytes(live.memUsed)}
                  </div>
                )}
              </div>
              <UnitInput
                label={`${s.label} CPU cores`}
                value={values[s.cpuKey]}
                unit="cores"
                step={0.1}
                min={MIN_CPUS}
                bad={invalid(values[s.cpuKey], MIN_CPUS)}
                onChange={set(s.cpuKey)}
              />
              <UnitInput
                label={`${s.label} memory in MB`}
                value={values[s.memKey]}
                unit="MB"
                step={128}
                min={MIN_MEM_MB}
                bad={invalid(values[s.memKey], MIN_MEM_MB)}
                onChange={set(s.memKey)}
              />
            </div>
          );
        })}
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_8rem] sm:items-start sm:gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[13px]" style={{ color: 'var(--text)' }}>
            <HardDrive size={13} style={{ color: 'var(--text-mute)' }} /> Disk
          </div>
          <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-mute)' }}>
            Database, files and backups together. Uploads are refused past it.
          </div>
          {diskUsed !== undefined && diskGb > 0 && (
            <div className="mt-2 max-w-sm">
              <Meter percent={(diskUsed / (diskGb * GIB)) * 100} />
              <div className="mt-1 text-[11px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
                {formatBytes(diskUsed)} used · {((diskUsed / (diskGb * GIB)) * 100).toFixed(1)}%
              </div>
            </div>
          )}
        </div>
        <UnitInput label="Disk in GB" value={values.diskGb} unit="GB" step={1} min={MIN_DISK_GB} bad={diskBad} onChange={set('diskGb')} />
      </div>

      <div className="flex flex-col gap-3 border-t hairline pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
          At least {MIN_CPUS} cores and {MIN_MEM_MB} MB per service. Saving recreates the containers: a few seconds of downtime.
        </p>
        <button
          onClick={() => save.mutate()}
          className="btn btn-primary shrink-0"
          disabled={!dirty || formInvalid || save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save and recreate'}
        </button>
      </div>
    </div>
  );
}
