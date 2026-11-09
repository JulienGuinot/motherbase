import type { MetricSample, RouteMetric } from '@/features/logs/types';

/**
 * Derived readings over the metrics window.
 *
 * The Observability screen used to show four current values and four line
 * charts, which answers "what is it now" and nothing else. These are the
 * questions the charts leave you to eyeball: is it getting worse, how much
 * traffic did the window actually carry, and how much of it succeeded.
 *
 * All of it is computed client-side from series the page already fetches, so
 * there is no new endpoint and no new sampling behind any of this.
 */

export interface Trend {
  /** Mean over the most recent third of the window. */
  current: number;
  /** Mean over the oldest third, the baseline `current` is compared against. */
  baseline: number;
  /** Signed fractional change, or null when the baseline is zero (no ratio exists). */
  changeRatio: number | null;
  direction: 'up' | 'down' | 'flat';
}

/** Change over the window: the newest third against the oldest third. */
export function trendOf(values: number[]): Trend {
  if (values.length === 0) return { current: 0, baseline: 0, changeRatio: null, direction: 'flat' };
  // Below 3 samples there is no "third" to compare; report the value as flat
  // rather than inventing a trend out of two points.
  if (values.length < 3) {
    const only = values[values.length - 1] ?? 0;
    return { current: only, baseline: only, changeRatio: null, direction: 'flat' };
  }

  const size = Math.max(1, Math.floor(values.length / 3));
  const mean = (list: number[]) => list.reduce((sum, value) => sum + value, 0) / list.length;
  const baseline = mean(values.slice(0, size));
  const current = mean(values.slice(-size));
  const changeRatio = baseline === 0 ? null : (current - baseline) / baseline;

  // A 5% wobble between two three-sample means is noise, not a trend.
  const direction: Trend['direction'] =
    changeRatio == null || Math.abs(changeRatio) < 0.05 ? 'flat' : changeRatio > 0 ? 'up' : 'down';

  return { current, baseline, changeRatio, direction };
}

export interface WindowSummary {
  /**
   * Requests across the window, summed over disjoint sample buckets.
   *
   * Each sample used to report its own trailing 60s window while the sampler ran
   * every 10s, so one request appeared in six consecutive samples and this sum
   * was roughly six times the traffic actually served. The server now counts
   * each bucket over the interval since the previous sample, which is what makes
   * this sum meaningful at all.
   */
  totalRequests: number;
  /** Requests that answered with an error status, on the same disjoint basis. */
  totalErrors: number;
  /** Share of requests that did not error, 0..1. */
  successRatio: number;
  peakRps: number;
  peakP95: number;
  /**
   * Median p95 across the buckets that actually carried traffic, or null when
   * none did. The screens used to headline the *last* bucket's p95, which is 0
   * whenever the most recent minute was idle: "p95 0ms, peak 475ms" was the
   * page telling the truth twice and reading as a bug both times.
   */
  typicalP95: number | null;
  /** Worst error rate any single sample saw, 0..1. */
  peakErrorRate: number;
  rps: Trend;
  p95: Trend;
  errorRate: Trend;
  memMb: Trend;
}

/** Median of a list, or null when it is empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarize(series: MetricSample[]): WindowSummary {
  const totalRequests = series.reduce((sum, sample) => sum + (sample.reqs ?? 0), 0);
  // `errs` is counted per bucket by the server. The `reqs * errorRate` fallback
  // is for a server that predates the field, and rounds the same way.
  const totalErrors = Math.round(
    series.reduce(
      (sum, sample) => sum + (sample.errs ?? (sample.reqs ?? 0) * (sample.errorRate ?? 0)),
      0,
    ),
  );
  const busy = series.filter(sample => (sample.reqs ?? 0) > 0);

  return {
    totalRequests,
    totalErrors,
    successRatio: totalRequests === 0 ? 1 : (totalRequests - totalErrors) / totalRequests,
    peakRps: series.length ? Math.max(...series.map(sample => sample.rps)) : 0,
    peakP95: series.length ? Math.max(...series.map(sample => sample.p95)) : 0,
    typicalP95: median(busy.map(sample => sample.p95)),
    peakErrorRate: series.length ? Math.max(...series.map(sample => sample.errorRate)) : 0,
    rps: trendOf(series.map(sample => sample.rps)),
    p95: trendOf(series.map(sample => sample.p95)),
    errorRate: trendOf(series.map(sample => sample.errorRate)),
    memMb: trendOf(series.map(sample => sample.memMb)),
  };
}

export type InsightLevel = 'critical' | 'warning' | 'info';

export interface Insight {
  id: string;
  level: InsightLevel;
  title: string;
  detail: string;
}

const LEVEL_RANK: Record<InsightLevel, number> = { critical: 0, warning: 1, info: 2 };

export interface InsightInputs {
  summary: WindowSummary;
  routes?: RouteMetric[];
  /** Postgres shared-buffer hit ratio as a percentage, when pg_stat is available. */
  cacheHitRatioPct?: number | null;
  /** Tables the performance report flagged as sequential-scan heavy. */
  missingIndexCandidates?: number;
  /** Queries running long enough to be worth a look. */
  longRunningQueries?: number;
}

/**
 * Plain-language readings of the numbers above, worst first.
 *
 * Thresholds are deliberately blunt and named here rather than configurable:
 * one honest default beats a settings page nobody opens. Adjust in this file.
 */
export function buildInsights({
  summary,
  routes = [],
  cacheHitRatioPct,
  missingIndexCandidates = 0,
  longRunningQueries = 0,
}: InsightInputs): Insight[] {
  const insights: Insight[] = [];
  const pct = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;

  const errorShare = summary.totalRequests === 0 ? 0 : summary.totalErrors / summary.totalRequests;
  if (errorShare >= 0.05) {
    insights.push({
      id: 'error-rate',
      level: 'critical',
      title: `${pct(errorShare)} of requests failed`,
      detail: `${summary.totalErrors} of ${summary.totalRequests} requests in this window answered with an error status.`,
    });
  } else if (errorShare >= 0.01) {
    insights.push({
      id: 'error-rate',
      level: 'warning',
      title: `${pct(errorShare)} of requests failed`,
      detail: `${summary.totalErrors} of ${summary.totalRequests} requests across the window. Under 1% is the usual background level.`,
    });
  }

  if (summary.p95.direction === 'up' && summary.p95.changeRatio != null && summary.p95.changeRatio >= 0.5) {
    insights.push({
      id: 'latency-trend',
      level: summary.p95.changeRatio >= 2 ? 'critical' : 'warning',
      title: `p95 latency up ${pct(summary.p95.changeRatio)}`,
      detail: `Now ${Math.round(summary.p95.current)}ms against ${Math.round(summary.p95.baseline)}ms at the start of the window.`,
    });
  }

  if (summary.memMb.direction === 'up' && summary.memMb.changeRatio != null && summary.memMb.changeRatio >= 0.3) {
    insights.push({
      id: 'memory-trend',
      level: 'warning',
      title: `Memory up ${pct(summary.memMb.changeRatio)} across the window`,
      detail: `RSS went from ${Math.round(summary.memMb.baseline)}MB to ${Math.round(summary.memMb.current)}MB. A steady climb with flat traffic is what a leak looks like.`,
    });
  }

  const worstRoute = [...routes].sort((a, b) => b.errors - a.errors)[0];
  if (worstRoute && worstRoute.errors > 0) {
    insights.push({
      id: 'route-errors',
      level: worstRoute.errors / Math.max(worstRoute.count, 1) >= 0.25 ? 'warning' : 'info',
      title: `${worstRoute.route} returned ${worstRoute.errors} errors`,
      detail: `${worstRoute.errors} of ${worstRoute.count} calls, p95 ${worstRoute.p95Ms}ms. The single noisiest route by failures.`,
    });
  }

  const slowest = [...routes].sort((a, b) => b.p95Ms - a.p95Ms)[0];
  if (slowest && slowest.p95Ms >= 1000) {
    insights.push({
      id: 'route-latency',
      level: 'warning',
      title: `${slowest.route} is the slowest route at ${slowest.p95Ms}ms p95`,
      detail: `Called ${slowest.count} times, averaging ${slowest.avgMs}ms. Anything past a second is felt by the caller.`,
    });
  }

  if (cacheHitRatioPct != null && cacheHitRatioPct < 95) {
    insights.push({
      id: 'cache-hit',
      level: cacheHitRatioPct < 90 ? 'warning' : 'info',
      title: `Postgres cache hit ratio ${cacheHitRatioPct.toFixed(1)}%`,
      detail: 'Below ~95% the working set is not staying in shared buffers, so reads are going to disk.',
    });
  }

  if (missingIndexCandidates > 0) {
    insights.push({
      id: 'missing-index',
      level: 'warning',
      title: `${missingIndexCandidates} table${missingIndexCandidates === 1 ? '' : 's'} scanning instead of seeking`,
      detail: 'Sequential scans dominate reads on these tables, so every read walks the whole table. The sequential scan share chart names them.',
    });
  }

  if (longRunningQueries > 0) {
    insights.push({
      id: 'long-queries',
      level: 'warning',
      title: `${longRunningQueries} quer${longRunningQueries === 1 ? 'y' : 'ies'} running long`,
      detail: 'Long transactions hold locks and keep dead rows alive, which blocks writers and grows the table.',
    });
  }

  if (insights.length === 0) {
    insights.push({
      id: 'healthy',
      level: 'info',
      title: 'Nothing needs attention',
      detail:
        summary.totalRequests === 0
          ? 'No traffic in this window yet.'
          : `${summary.totalRequests} requests, ${pct(summary.successRatio)} succeeded, p95 steady at ${Math.round(summary.p95.current)}ms.`,
    });
  }

  return insights.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
}
