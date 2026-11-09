import { useState } from 'react';
import { Cpu, MemoryStick } from 'lucide-react';
import { usePlatformMetrics } from '@/features/projects/hooks/useProjects';
import { serviceLabel } from '@/shared/lib/project-services';
import { Section } from '@/shared/ui/Section';
import { formatBytes } from '@/shared/lib/format';
import { useResourceAlertThresholds } from '@/shared/lib/resourceAlerts';
import { FleetUsage } from '@/features/platform/components/FleetUsage';
import { DiskUsageCard } from '@/features/platform/components/DiskUsageCard';
import { UsageMeter } from '@/features/projects/components/UsageMeter';
import { AlertSettingsModal } from '@/features/projects/components/AlertSettingsModal';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';

// Org > Usage: fleet-wide resource consumption and per-project breakdown.
export default function Usage() {
  const metricsQ = usePlatformMetrics();
  const { cpuThreshold, memThreshold, setCpuThreshold, setMemThreshold } = useResourceAlertThresholds();
  const [showAlerts, setShowAlerts] = useState(false);
  const projects = metricsQ.data?.projects ?? [];
  const containers = metricsQ.data?.containers ?? [];

  return (
    <PageShell>
      <PageHeader
        size="md"
        title="Usage"
        subtitle="CPU, memory and disk across every project. Set alert thresholds to get notified when a project runs hot."
      />

        <FleetUsage onAdjustThresholds={() => setShowAlerts(true)} />

        <DiskUsageCard />

        <Section
          title="Per project"
          description="Each project against its quota. The edge runtime is a container of the project, so it counts in the project's totals."
          actions={<span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>{projects.length} project{projects.length === 1 ? '' : 's'}</span>}
          flush
        >
          {projects.length === 0 ? (
            <p className="px-5 py-4 text-[12px]" style={{ color: 'var(--text-mute)' }}>No running projects to measure.</p>
          ) : (
            <ul>
              {projects.map(u => (
                <li key={u.project} className="grid gap-4 border-t hairline px-5 py-4 first:border-t-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-start">
                  <div className="min-w-0">
                    <div className="truncate text-[13px]" style={{ fontWeight: 500 }}>{u.project}</div>
                    <div className="mt-1 space-y-0.5 text-[11px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
                      {containers.filter(c => c.project === u.project).map(c => (
                        <div key={c.service} className="flex justify-between gap-3">
                          <span>{serviceLabel(c.service)}</span>
                          <span>{c.cpuPercent.toFixed(1)}% · {formatBytes(c.memUsed)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <UsageMeter
                    icon={Cpu}
                    label="CPU"
                    percent={u.cpuLimit ? u.cpuPct ?? 0 : Math.min(100, u.cpuPercent)}
                    value={`${u.cpuPercent.toFixed(1)}%`}
                    limit={u.cpuLimit ? `${u.cpuLimit} core${u.cpuLimit === 1 ? '' : 's'}` : 'default'}
                    hasQuota={u.cpuLimit != null}
                  />
                  <UsageMeter
                    icon={MemoryStick}
                    label="Memory"
                    percent={u.memLimitBytes ? u.memPct ?? 0 : Math.min(100, u.memPercent)}
                    value={formatBytes(u.memUsed)}
                    limit={u.memLimitBytes ? formatBytes(u.memLimitBytes) : 'default'}
                    hasQuota={u.memLimitBytes != null}
                  />
                </li>
              ))}
            </ul>
          )}
        </Section>

      {showAlerts && (
        <AlertSettingsModal
          cpuThreshold={cpuThreshold}
          memThreshold={memThreshold}
          onChangeCpu={setCpuThreshold}
          onChangeMem={setMemThreshold}
          onClose={() => setShowAlerts(false)}
        />
      )}
    </PageShell>
  );
}
