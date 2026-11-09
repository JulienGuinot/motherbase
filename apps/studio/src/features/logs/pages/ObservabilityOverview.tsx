'use client';

import { useMemo, useState } from 'react';
import { Activity, AlertTriangle, Gauge, Cpu, CheckCircle2, Layers } from 'lucide-react';
import ChartCard from '@/shared/ui/charts/ChartCard';
import AreaTrend from '@/shared/ui/charts/AreaTrend';
import BarTrend from '@/shared/ui/charts/BarTrend';
import RangePicker from '@/shared/ui/RangePicker';
import type { RangeKey } from '@/shared/lib/range';
import { formatClock, formatMs, formatPercent } from '@/shared/lib/format';
import { Kpi } from '@/features/logs/components/Kpi';
import { InsightList } from '@/features/logs/components/InsightList';
import { RouteMetrics } from '@/features/logs/components/AdvisorRouteMetrics';
import { buildInsights, summarize } from '@/features/logs/lib/insights';
import { useMetricsTimeseries, useStats } from '@/features/logs/hooks/useReports';
import { useShield } from '@/features/logs/hooks/useAdvisor';
import { EmptyState } from '@/shared/ui/EmptyState';
import { CoverageNotice } from '@/features/logs/components/CoverageNotice';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';


// Observability landing: the full runtime picture for this API process. The
// API Gateway and Query Performance sub-pages zoom into cuts of the same data.
export default function ObservabilityOverview() {
  const [range, setRange] = useState<RangeKey>('1h');

  const seriesQ = useMetricsTimeseries(range);
  const statsQ = useStats();
  // Route-level telemetry the Advisor already collects. Reused here so the
  // overview can name the route behind a bad number instead of only charting it.
  const shieldQ = useShield(range);

  const series = useMemo(() => seriesQ.data?.samples ?? [], [seriesQ.data]);
  const coverage = seriesQ.data?.coverage;
  const last = series[series.length - 1];

  const topTables = useMemo(
    () => [...(statsQ.data?.counts ?? [])].sort((a, b) => b.count - a.count).slice(0, 12),
    [statsQ.data],
  );

  const summary = useMemo(() => summarize(series), [series]);
  const routes = useMemo(() => shieldQ.data?.telemetry.routes ?? [], [shieldQ.data]);
  const insights = useMemo(() => buildInsights({ summary, routes }), [summary, routes]);

  return (
    <PageShell width="wide">
      <PageHeader
        size="sm"
        title="Observability"
        subtitle="Runtime metrics for this API process, sampled every 10s, in-memory (resets on restart)."
        actions={<RangePicker value={range} onChange={setRange} />}
      />

      <CoverageNotice coverage={coverage} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi icon={<Activity size={14} />} label="Requests / sec" value={(last?.rps ?? 0).toFixed(2)} sub={`peak ${summary.peakRps.toFixed(2)}`} color="var(--accent)" trend={summary.rps} polarity="neutral" />
        <Kpi
          icon={<Gauge size={14} />}
          label="p95 latency"
          value={summary.typicalP95 == null ? 'n/a' : formatMs(summary.typicalP95)}
          sub={summary.typicalP95 == null ? 'no traffic in window' : `median bucket · peak ${formatMs(summary.peakP95)}`}
          color="var(--green)"
          trend={summary.p95}
          polarity="lower-is-better"
        />
        <Kpi icon={<AlertTriangle size={14} />} label="Error rate" value={formatPercent(last?.errorRate ?? 0)} sub={`peak ${formatPercent(summary.peakErrorRate)}`} color="var(--red)" trend={summary.errorRate} polarity="lower-is-better" />
        <Kpi icon={<CheckCircle2 size={14} />} label="Success rate" value={formatPercent(summary.successRatio)} sub={`${summary.totalErrors} failed`} color="var(--green)" />
        <Kpi icon={<Layers size={14} />} label="Requests" value={summary.totalRequests.toLocaleString()} sub={`in last ${range}`} color="var(--blue)" />
        <Kpi icon={<Cpu size={14} />} label="Memory (RSS)" value={`${(last?.memMb ?? 0).toFixed(0)} MB`} sub="process resident" color="var(--amber)" trend={summary.memMb} polarity="lower-is-better" />
      </div>

      <InsightList insights={insights} />

      {series.length === 0 ? (
        <EmptyState className="card" size="md" mascot="listening-sonar" title="Collecting samples…" description="Charts appear once the sampler has data (first ~10s)." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title="API traffic" value={`${(last?.rps ?? 0).toFixed(2)} rps`} hint={range}>
            <AreaTrend data={series} xKey="at" yKey="rps" color="var(--accent)" labelFormat={formatClock} format={v => v.toFixed(2)} />
          </ChartCard>
          <ChartCard title="p95 latency" value={summary.typicalP95 == null ? 'n/a' : formatMs(summary.typicalP95)} hint={range}>
            <AreaTrend data={series} xKey="at" yKey="p95" color="var(--green)" labelFormat={formatClock} format={v => formatMs(v)} />
          </ChartCard>
          <ChartCard title="Error rate" value={formatPercent(last?.errorRate ?? 0)} hint={range}>
            <AreaTrend data={series} xKey="at" yKey="errorRate" color="var(--red)" labelFormat={formatClock} format={formatPercent} />
          </ChartCard>
          <ChartCard title="Memory (RSS)" value={`${(last?.memMb ?? 0).toFixed(0)} MB`} hint={range}>
            <AreaTrend data={series} xKey="at" yKey="memMb" color="var(--amber)" labelFormat={formatClock} format={v => `${v.toFixed(0)}MB`} />
          </ChartCard>
        </div>
      )}

      <RouteMetrics routes={routes} />

      <ChartCard title="Largest tables" hint="row counts">
        {topTables.length === 0
          ? <EmptyState title="No tables yet" description="Table statistics appear once this project has tables with rows in them." />
          : <BarTrend data={topTables} xKey="model" yKey="count" color="var(--accent)" height={240} format={v => v.toLocaleString()} />}
      </ChartCard>
    </PageShell>
  );
}
