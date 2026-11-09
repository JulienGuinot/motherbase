'use client';

import { useMemo, useState } from 'react';
import { Activity, Gauge, AlertTriangle, CheckCircle2, Layers } from 'lucide-react';
import ChartCard from '@/shared/ui/charts/ChartCard';
import AreaTrend from '@/shared/ui/charts/AreaTrend';
import RangePicker from '@/shared/ui/RangePicker';
import type { RangeKey } from '@/shared/lib/range';
import { formatClock, formatMs, formatPercent } from '@/shared/lib/format';
import { Kpi } from '@/features/logs/components/Kpi';
import { InsightList } from '@/features/logs/components/InsightList';
import { RouteMetrics } from '@/features/logs/components/AdvisorRouteMetrics';
import { buildInsights, summarize } from '@/features/logs/lib/insights';
import { useMetricsTimeseries } from '@/features/logs/hooks/useReports';
import { useShield } from '@/features/logs/hooks/useAdvisor';
import { EmptyState } from '@/shared/ui/EmptyState';
import { CoverageNotice } from '@/features/logs/components/CoverageNotice';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';


// API Gateway view: request throughput, latency and errors over time.
export default function ObservabilityApi() {
  const [range, setRange] = useState<RangeKey>('1h');
  const seriesQ = useMetricsTimeseries(range);
  // Same window as the charts.
  const shieldQ = useShield(range);

  const series = useMemo(() => seriesQ.data?.samples ?? [], [seriesQ.data]);
  const coverage = seriesQ.data?.coverage;
  const last = series[series.length - 1];
  const summary = useMemo(() => summarize(series), [series]);
  const routes = useMemo(() => shieldQ.data?.telemetry.routes ?? [], [shieldQ.data]);
  const insights = useMemo(() => buildInsights({ summary, routes }), [summary, routes]);

  // Same telemetry, ordered by latency rather than volume: the routes worth
  // fixing are rarely the ones called most.
  const slowestRoutes = useMemo(() => [...routes].sort((a, b) => b.p95Ms - a.p95Ms), [routes]);

  return (
    <PageShell width="wide">
      <PageHeader
        size="sm"
        title="API Gateway"
        subtitle="Request throughput, latency and error rate."
        actions={<RangePicker value={range} onChange={setRange} />}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi icon={<Activity size={14} />} label="Requests / sec" value={(last?.rps ?? 0).toFixed(2)} sub={`peak ${summary.peakRps.toFixed(2)}`} color="var(--accent)" trend={summary.rps} />
        <Kpi icon={<Layers size={14} />} label="Requests" value={summary.totalRequests.toLocaleString()} sub={`in last ${range}`} color="var(--blue)" />
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
      </div>

      <CoverageNotice coverage={coverage} />

      <InsightList insights={insights} />

      {series.length === 0 ? (
        <EmptyState className="card" size="md" mascot="listening-sonar" title="Collecting samples…" description="Charts appear once the sampler has data (first ~10s)." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title="Throughput" value={`${(last?.rps ?? 0).toFixed(2)} rps`} hint={range}>
            <AreaTrend data={series} xKey="at" yKey="rps" color="var(--accent)" labelFormat={formatClock} format={v => v.toFixed(2)} />
          </ChartCard>
          <ChartCard title="p95 latency" value={summary.typicalP95 == null ? 'n/a' : formatMs(summary.typicalP95)} hint={range}>
            <AreaTrend data={series} xKey="at" yKey="p95" color="var(--green)" labelFormat={formatClock} format={v => formatMs(v)} />
          </ChartCard>
          <ChartCard title="Error rate" value={formatPercent(last?.errorRate ?? 0)} hint={range}>
            <AreaTrend data={series} xKey="at" yKey="errorRate" color="var(--red)" labelFormat={formatClock} format={formatPercent} />
          </ChartCard>
          <ChartCard title="Requests / bucket" value={`${last?.reqs ?? 0}`} hint={range}>
            <AreaTrend data={series} xKey="at" yKey="reqs" color="var(--amber)" labelFormat={formatClock} format={v => v.toFixed(0)} />
          </ChartCard>
        </div>
      )}

      <RouteMetrics routes={routes} />
      <RouteMetrics routes={slowestRoutes} title="Slowest routes" />
    </PageShell>
  );
}
