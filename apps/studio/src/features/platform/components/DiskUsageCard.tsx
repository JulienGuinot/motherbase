'use client';

import { HardDrive } from 'lucide-react';
import { usePlatformDisk } from '@/features/projects/hooks/useProjects';
import { usePreferences } from '@/shared/lib/theme';
import { formatBytes, formatRelativeTime } from '@/shared/lib/format';
import { toSlices } from '@/shared/ui/charts/palette';
import { Section } from '@/shared/ui/Section';

/**
 * How full a project's bar is, against what its text names: the project's
 * quota, or the whole disk when it has none. Null when neither is known.
 * It used to be scaled to the largest project, so that one always looked full.
 */
export function projectFill(size: number, quota: number | undefined, diskTotal: number | undefined): number | null {
  const capacity = quota || diskTotal;
  return capacity ? (size / capacity) * 100 : null;
}

function usageColor(percent: number) {
  return percent >= 90 ? 'var(--red)' : percent >= 75 ? 'var(--amber)' : 'var(--accent)';
}

/**
 * Raw disk: the server's filesystem (used / free) and what each project's
 * Docker volumes (database, storage files, backups) occupy on it. Stopped
 * projects still hold their volumes, so they are listed too.
 */
export function DiskUsageCard() {
  const q = usePlatformDisk();
  const { resolvedTheme } = usePreferences();
  const host = q.data?.host ?? null;
  const projects = q.data?.projects ?? [];
  const projectsTotal = projects.reduce((sum, p) => sum + p.size, 0);
  const slices = toSlices(projects.map(p => ({ label: p.project, value: p.size })), resolvedTheme);

  return (
    <Section
      title={<span className="flex items-center gap-2"><HardDrive size={13} style={{ color: 'var(--text-mute)' }} /> Disk</span>}
      actions={q.data?.measuredAt && (
        <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
          Volumes measured {formatRelativeTime(q.data.measuredAt)}
        </span>
      )}
    >
      {q.isPending ? (
        <div className="h-16 shimmer rounded-lg" />
      ) : (
        <>
          {host && (
            <div>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[13px]" style={{ color: 'var(--text-dim)' }}>Server disk</span>
                <span className="text-[13px] tabular-nums">
                  <span style={{ fontWeight: 600, color: usageColor(host.percent) }}>{host.percent}%</span>
                  <span style={{ color: 'var(--text-mute)' }}>
                    {' '}· {formatBytes(host.used)} used of {formatBytes(host.total)} · {formatBytes(host.free)} free
                  </span>
                </span>
              </div>
              {/* Used space, with each project's share of it drawn in its own colour. */}
              <div className="mt-2 flex h-2.5 w-full overflow-hidden" style={{ background: 'var(--surface-2)', borderRadius: 999 }}>
                {slices.map(s => (
                  <div key={s.label} title={`${s.label} · ${formatBytes(s.value)}`}
                    style={{ width: `${(s.value / host.total) * 100}%`, background: s.color }} />
                ))}
                <div title={`System, images and other data · ${formatBytes(Math.max(0, host.used - projectsTotal))}`}
                  style={{ width: `${(Math.max(0, host.used - projectsTotal) / host.total) * 100}%`, background: 'var(--text-mute)', opacity: 0.5 }} />
              </div>
              <div className="mt-2 text-[11px]" style={{ color: 'var(--text-mute)' }}>
                Projects {formatBytes(projectsTotal)} · system, images and other data {formatBytes(Math.max(0, host.used - projectsTotal))} · mounted at {host.path}
              </div>
            </div>
          )}

          {projects.length === 0 ? (
            <p className="mt-4 text-[12px] first:mt-0" style={{ color: 'var(--text-mute)' }}>
              {q.isError ? 'Volume sizes are unavailable right now.' : 'No project volumes on disk yet.'}
            </p>
          ) : (
            <ul className="mt-5 space-y-3 first:mt-0">
              {projects.map(p => {
                const color = slices.find(s => s.label === p.project)?.color ?? 'var(--text-mute)';
                const percent = projectFill(p.size, p.quota, host?.total);
                return (
                  <li key={p.project}>
                    <div className="flex items-center justify-between gap-3 text-[13px]">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                        <span className="truncate" style={{ fontWeight: 500 }}>{p.project}</span>
                      </span>
                      <span className="tabular-nums">
                        {formatBytes(p.size)}
                        {p.quota ? (
                          <span style={{ color: p.size > p.quota ? 'var(--red)' : 'var(--text-mute)' }}>
                            {' '}of {formatBytes(p.quota)} quota
                          </span>
                        ) : null}
                        {percent !== null && (
                          <span style={{ color: 'var(--text-mute)' }}>
                            {' '}· {percent.toFixed(1)}% of {p.quota ? 'quota' : 'disk'}
                          </span>
                        )}
                      </span>
                    </div>
                    {percent !== null && (
                      <div className="mt-1 h-1.5 w-full overflow-hidden" style={{ background: 'var(--surface-2)', borderRadius: 999 }}>
                        <div className="h-full" style={{
                          width: `${Math.min(100, Math.max(1, percent))}%`,
                          background: p.quota ? usageColor(percent) : color,
                          borderRadius: 999,
                        }} />
                      </div>
                    )}
                    <div className="mt-1 text-[11px]" style={{ color: 'var(--text-mute)' }}>
                      {p.volumes.map(v => `${v.label} ${formatBytes(v.size)}`).join(' · ')}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}
