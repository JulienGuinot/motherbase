'use client';

import { useMemo, useState } from 'react';
import { Database, Gauge, Cpu, HardDrive, Search } from 'lucide-react';
import ChartCard from '@/shared/ui/charts/ChartCard';
import AreaTrend from '@/shared/ui/charts/AreaTrend';
import BarTrend from '@/shared/ui/charts/BarTrend';
import RangePicker from '@/shared/ui/RangePicker';
import type { RangeKey } from '@/shared/lib/range';
import { formatClock, formatMs } from '@/shared/lib/format';
import { Kpi } from '@/features/logs/components/Kpi';
import { InsightList } from '@/features/logs/components/InsightList';
import { buildInsights, summarize } from '@/features/logs/lib/insights';
import { useMetricsTimeseries, useStats } from '@/features/logs/hooks/useReports';
import { usePerformance } from '@/features/logs/hooks/useAdvisor';
import { EmptyState } from '@/shared/ui/EmptyState';
import { CoverageNotice } from '@/features/logs/components/CoverageNotice';
import { SlowQueriesSection } from '@/features/logs/components/PerformancePanel';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';


/** Below this a sequential-scan share is statistical noise, not a finding. */
const MIN_READS_FOR_SCAN_RATIO = 50;

// Query Performance view: table volumes and the process resource envelope the
// database work runs inside.
export default function ObservabilityDatabase() {
  const [range, setRange] = useState<RangeKey>('1h');
  const seriesQ = useMetricsTimeseries(range);
  const statsQ = useStats();
  // The same Postgres report the Advisor's performance tab renders. Passing the
  // category it gates on is what enables the query.
  const perfQ = usePerformance('performance');

  const series = useMemo(() => seriesQ.data?.samples ?? [], [seriesQ.data]);
  const coverage = seriesQ.data?.coverage;
  const last = series[series.length - 1];
  const counts = useMemo(() => statsQ.data?.counts ?? [], [statsQ.data?.counts]);
  const totalRows = counts.reduce((s, c) => s + c.count, 0);
  const topTables = useMemo(() => [...counts].sort((a, b) => b.count - a.count).slice(0, 12), [counts]);

  const cacheHitRatioPct = perfQ.data?.cacheHitRatio.ratioPct ?? null;
  const missingIndexCandidates = perfQ.data?.missingIndexCandidates.length ?? 0;
  const longRunningQueries = perfQ.data?.activeQueries.length ?? 0;

  const summary = useMemo(() => summarize(series), [series]);
  const insights = useMemo(
    () => buildInsights({ summary, cacheHitRatioPct, missingIndexCandidates, longRunningQueries }),
    [summary, cacheHitRatioPct, missingIndexCandidates, longRunningQueries],
  );

  // Sequential scans that dominate index scans are the single most actionable
  // number on this page, so it gets its own chart rather than a table row.
  //
  // Only tables with enough reads for the ratio to mean anything: a table read
  // three times, all three sequentially, is 100% and worth nothing. The server
  // gates its insight the same way (`admin-performance.service.ts`), so the
  // chart and the insight agree on which tables are affected.
  const scanRatios = useMemo(
    () =>
      (perfQ.data?.tableScans ?? [])
        .filter(scan => scan.seqScan + scan.idxScan >= MIN_READS_FOR_SCAN_RATIO)
        .map(scan => ({
          table: `${scan.schema}.${scan.table}`,
          seqPct: Math.round((scan.seqScan / (scan.seqScan + scan.idxScan)) * 100),
          reads: scan.seqScan + scan.idxScan,
        }))
        .filter(row => row.seqPct > 0)
        .sort((a, b) => b.seqPct - a.seqPct || b.reads - a.reads)
        .slice(0, 10),
    [perfQ.data],
  );

  return (
    <PageShell width="wide">
      <PageHeader
        size="sm"
        title="Query Performance"
        subtitle="Table volumes, Postgres read behaviour, and the resource envelope queries run inside."
        actions={<RangePicker value={range} onChange={setRange} />}
      />

      <CoverageNotice coverage={coverage} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi icon={<Database size={14} />} label="Total rows" value={totalRows.toLocaleString()} sub={`${counts.length} models`} color="var(--accent)" />
        <Kpi
          icon={<HardDrive size={14} />}
          label="Cache hit ratio"
          value={cacheHitRatioPct == null ? 'n/a' : `${cacheHitRatioPct.toFixed(1)}%`}
          sub={cacheHitRatioPct == null ? 'pg_stat unavailable' : 'shared buffers'}
          color="var(--blue)"
        />
        <Kpi icon={<Search size={14} />} label="Scan-heavy tables" value={String(missingIndexCandidates)} sub="index candidates" color="var(--amber)" />
        <Kpi
          icon={<Gauge size={14} />}
          label="p95 latency"
          value={summary.typicalP95 == null ? 'n/a' : formatMs(summary.typicalP95)}
          sub={summary.typicalP95 == null ? 'no traffic in window' : `median bucket · peak ${formatMs(summary.peakP95)}`}
          color="var(--green)"
          trend={summary.p95}
          polarity="lower-is-better"
        />
        <Kpi icon={<Cpu size={14} />} label="Memory (RSS)" value={`${(last?.memMb ?? 0).toFixed(0)} MB`} sub="process resident" color="var(--amber)" trend={summary.memMb} polarity="lower-is-better" />
      </div>

      <InsightList insights={insights} />

      {/* Supabase's Query Performance is this list, with the index advisor one
          click from each row. */}
      {perfQ.data && <SlowQueriesSection slowQueries={perfQ.data.slowQueries} />}

      <ChartCard title="Largest tables" hint="row counts">
        {topTables.length === 0
          ? <EmptyState mascot="hugging-postgres" title="No tables yet" description="Table statistics appear once this project has tables with rows in them." />
          : <BarTrend data={topTables} xKey="model" yKey="count" color="var(--accent)" height={28 * topTables.length + 30} format={v => v.toLocaleString()} horizontal />}
      </ChartCard>

      {scanRatios.length > 0 && (
        <ChartCard title="Sequential scan share" hint={`% of reads not using an index · tables with ${MIN_READS_FOR_SCAN_RATIO}+ reads`}>
          <BarTrend
            data={scanRatios}
            xKey="table"
            yKey="seqPct"
            color="var(--amber)"
            height={28 * scanRatios.length + 30}
            format={v => `${v}%`}
            horizontal
            categoryWidth={190}
          />
        </ChartCard>
      )}

      {series.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title="p95 latency" value={summary.typicalP95 == null ? 'n/a' : formatMs(summary.typicalP95)} hint={range}>
            <AreaTrend data={series} xKey="at" yKey="p95" color="var(--green)" labelFormat={formatClock} format={v => formatMs(v)} />
          </ChartCard>
          <ChartCard title="Memory (RSS)" value={`${(last?.memMb ?? 0).toFixed(0)} MB`} hint={range}>
            <AreaTrend data={series} xKey="at" yKey="memMb" color="var(--amber)" labelFormat={formatClock} format={v => `${v.toFixed(0)}MB`} />
          </ChartCard>
        </div>
      )}
    </PageShell>
  );
}
