import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { AlertTriangle } from 'lucide-react';
import { usePlatformMetrics } from '@/features/projects/hooks/useProjects';
import { usePreferences } from '@/shared/lib/theme';
import { formatBytes } from '@/shared/lib/format';
import { DonutChart, DonutLegend } from '@/shared/ui/DonutChart';
import Sparkline from '@/shared/ui/Sparkline';
import { getFleetUsageHistory, recordFleetUsage, subscribeFleetUsageHistory } from '@/features/platform/lib/fleet-usage-history';
import { toSlices } from '@/shared/ui/charts/palette';
import { Section } from '@/shared/ui/Section';

// Fleet-wide CPU/memory breakdown + trend across all projects. Extracted from
// the Projects page so the org-level Usage screen and the projects list can both
// show it. Owns its own metrics polling and persisted trend history.
export function FleetUsage({ onAdjustThresholds }: { onAdjustThresholds?: () => void }) {
  const metricsQ = usePlatformMetrics();
  const { resolvedTheme } = usePreferences();

  const usageHistory = useSyncExternalStore(
    subscribeFleetUsageHistory,
    getFleetUsageHistory,
    getFleetUsageHistory,
  );
  useEffect(() => {
    recordFleetUsage(metricsQ.data?.projects ?? [], metricsQ.dataUpdatedAt);
  }, [metricsQ.data?.projects, metricsQ.dataUpdatedAt]);

  const cpuSlices = useMemo(() => toSlices(
    (metricsQ.data?.projects ?? []).map(p => ({ label: p.project, value: p.cpuPercent })),
    resolvedTheme,
  ), [metricsQ.data, resolvedTheme]);
  const memSlices = useMemo(() => toSlices(
    (metricsQ.data?.projects ?? []).map(p => ({ label: p.project, value: p.memUsed })),
    resolvedTheme,
  ), [metricsQ.data, resolvedTheme]);

  const projectCount = metricsQ.data?.projects?.length ?? 0;

  return (
    <Section
      title="Fleet resource usage"
      actions={onAdjustThresholds && (
        <button onClick={onAdjustThresholds} className="btn btn-ghost">
          <AlertTriangle size={12} /> Alert thresholds
        </button>
      )}
    >
      {projectCount === 0 ? (
        <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>No running projects to measure yet.</p>
      ) : (
        <div className="grid gap-6 md:grid-cols-3">
          <div>
            <div className="label mb-3">CPU by project</div>
            <DonutChart slices={cpuSlices} centerLabel="CPU" centerValue={`${cpuSlices.reduce((s, x) => s + x.value, 0).toFixed(0)}%`} />
            <div className="mt-3"><DonutLegend slices={cpuSlices} /></div>
          </div>
          <div>
            <div className="label mb-3">Memory by project</div>
            <DonutChart slices={memSlices} centerLabel="Memory" centerValue={formatBytes(memSlices.reduce((s, x) => s + x.value, 0))} />
            <div className="mt-3"><DonutLegend slices={memSlices} /></div>
          </div>
          <div>
            <div className="label mb-3">Average usage · trend</div>
            {usageHistory.length < 2 ? (
              <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
                Collecting samples: the trend fills in as the fleet is polled (every 5s) and persists across reloads.
              </p>
            ) : (
              <div className="space-y-3">
                <div>
                  <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--text-mute)' }}>
                    <span>CPU</span>
                    <span className="tabular-nums">{(usageHistory.at(-1)?.cpu ?? 0).toFixed(1)}%</span>
                  </div>
                  <Sparkline values={usageHistory.map(h => h.cpu)} width={220} height={40} color="var(--accent)" />
                </div>
                <div>
                  <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--text-mute)' }}>
                    <span>Memory</span>
                    <span className="tabular-nums">{(usageHistory.at(-1)?.mem ?? 0).toFixed(1)}%</span>
                  </div>
                  <Sparkline values={usageHistory.map(h => h.mem)} width={220} height={40} color="var(--green)" />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}
