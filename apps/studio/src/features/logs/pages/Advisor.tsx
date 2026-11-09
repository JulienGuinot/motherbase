'use client';

import { useState } from 'react';
import { Activity, AlertTriangle, Ban, Gauge, ListChecks, RefreshCw } from 'lucide-react';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { StatCard } from '@/shared/ui/StatCard';
import { Tabs } from '@/shared/ui/Tabs';
import { RouteMetrics } from '@/features/logs/components/AdvisorRouteMetrics';
import { AdvisorFindings } from '@/features/logs/components/AdvisorFindings';
import { EdgePostureCard, LevelCounts, RateLimitCard } from '@/features/logs/components/AdvisorPosture';
import { PerformancePanel } from '@/features/logs/components/PerformancePanel';
import { usePerformance, useShield } from '@/features/logs/hooks/useAdvisor';
import { CATEGORIES, CATEGORY_META, selectFindings, type AdvisorCategory } from '@/features/logs/lib/advisor-meta';

export default function Advisor() {
  const [category, setCategory] = useState<AdvisorCategory>('all');
  const shield = useShield();
  const performance = usePerformance(category === 'all' ? 'security' : category);
  const scanning = shield.isFetching || performance.isFetching;
  const report = shield.data;
  const recommendations = report?.recommendations ?? [];
  const findings = selectFindings(recommendations, category);

  function rescan() {
    void shield.refetch();
    if (category === 'performance') void performance.refetch();
  }

  return (
    <PageShell width="wide">
      <PageHeader
        title="Advisor"
        subtitle="Find risks in your backend, understand their impact, and see what to fix."
        actions={
          <button onClick={rescan} disabled={scanning} className="btn">
            <RefreshCw size={13} className={scanning ? 'animate-spin' : undefined} />
            {scanning ? 'Scanning...' : 'Run checks'}
          </button>
        }
      />

      {shield.isError && (
        <div role="alert" className="card flex items-start gap-3 p-4" style={{ borderLeftColor: 'var(--danger)', borderLeftWidth: 3 }}>
          <AlertTriangle size={18} className="shrink-0" style={{ color: 'var(--danger)' }} />
          <div>
            <p className="text-[13px] font-semibold">{report ? 'The latest scan failed' : 'Checks could not be loaded'}</p>
            <p className="mt-1 text-[13px]" style={{ color: 'var(--text-dim)' }}>
              {report ? 'Showing the previous results. Run checks again to refresh them.' : 'Run checks again to retry. No health assessment is available yet.'}
            </p>
          </div>
        </div>
      )}

      {report && (
        <section aria-label="Scan summary" className="card flex flex-wrap items-center justify-between gap-5 p-5">
          <div>
            <h2 className="text-[16px] font-semibold">
              {recommendations.length ? `${recommendations.length} recommendations to review` : 'No issues detected by the current checks'}
            </h2>
            <p className="mt-1 text-[13px]" style={{ color: 'var(--text-dim)' }}>
              Review critical findings first, then warnings and suggestions.
            </p>
            <p className="mt-3 text-[11px]" style={{ color: 'var(--text-mute)' }}>
              Last checked {new Date(report.ranAt).toLocaleString()}
            </p>
          </div>
          <LevelCounts counts={report.counts} />
        </section>
      )}

      <section aria-label="Recommendations" className="space-y-4">
        <Tabs<AdvisorCategory>
          value={category}
          onChange={setCategory}
          items={[
            { id: 'all', label: 'All checks', icon: ListChecks, badge: report ? <span className="chip tabular-nums">{recommendations.length}</span> : undefined },
            ...CATEGORIES.map(key => ({
              id: key,
              label: CATEGORY_META[key].label,
              icon: CATEGORY_META[key].Icon,
              badge: report ? <span className="chip tabular-nums">{recommendations.filter(finding => finding.category === key).length}</span> : undefined,
            })),
          ]}
        />
        {(report || shield.isLoading) && (
          <AdvisorFindings findings={findings} isLoading={shield.isLoading}
            categoryLabel={category === 'all' ? 'All checks' : CATEGORY_META[category].label} />
        )}
        {category === 'performance' && (
          <details className="card p-4">
            <summary className="cursor-pointer text-[13px] font-semibold">Database performance details</summary>
            <div className="mt-4">
              <PerformancePanel report={performance.data} loading={performance.isLoading} error={performance.isError} />
            </div>
          </details>
        )}
      </section>

      {report && (
        <details className="card p-4 sm:p-5">
          <summary className="cursor-pointer text-[14px] font-semibold">
            Activity & configuration
            <span className="mt-1 block text-[12px] font-normal" style={{ color: 'var(--text-dim)' }}>
              Request traffic, edge functions and rate limits behind these checks.
            </span>
          </summary>
          <div className="mt-5 space-y-4">
            <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>Traffic counts reflect the server's current telemetry buffer.</p>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <StatCard size="sm" icon={Activity} label="Requests" value={report.telemetry.counts.requests} />
              <StatCard size="sm" icon={AlertTriangle} label="Errors" value={report.telemetry.counts.errors} color="var(--red)" />
              <StatCard size="sm" icon={Gauge} label="Slow requests" value={report.telemetry.counts.slow} color="var(--amber)" />
              <StatCard size="sm" icon={Ban} label="Rate limited" value={report.telemetry.counts.rateLimited} color="var(--amber)" />
            </div>
            <div className="grid gap-3 xl:grid-cols-2">
              <EdgePostureCard publicInvoke={report.edge.publicInvokeEnabled} secrets={report.edge.secretsEnabled} enabledFunctions={report.edge.enabledFunctions} />
              <RateLimitCard windowMs={report.rateLimit.windowMs} limits={report.rateLimit.limits} />
            </div>
            <RouteMetrics routes={report.telemetry.routes} title="Most active routes" />
          </div>
        </details>
      )}
    </PageShell>
  );
}
