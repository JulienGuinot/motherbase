import { describe, expect, it } from 'vitest';
import { buildInsights, summarize, trendOf } from '@/features/logs/lib/insights';
import type { MetricSample } from '@/features/logs/types';

function sample(overrides: Partial<MetricSample>): MetricSample {
  return {
    at: '2026-08-23T10:00:00.000Z',
    rps: 1,
    p95: 50,
    errorRate: 0,
    memMb: 100,
    reqs: 60,
    errs: 0,
    bucketMs: 10_000,
    ...overrides,
  };
}

describe('trendOf', () => {
  it('reports no trend when there are too few samples to have thirds', () => {
    expect(trendOf([10, 90]).direction).toBe('flat');
    expect(trendOf([10, 90]).changeRatio).toBeNull();
  });

  it('treats small movement as flat rather than a trend', () => {
    expect(trendOf([100, 100, 100, 102, 101, 102]).direction).toBe('flat');
  });

  it('measures the newest third against the oldest third', () => {
    const trend = trendOf([100, 100, 100, 150, 200, 200]);
    expect(trend.baseline).toBe(100);
    expect(trend.current).toBe(200);
    expect(trend.changeRatio).toBe(1);
    expect(trend.direction).toBe('up');
  });

  it('has no ratio to report against a zero baseline', () => {
    expect(trendOf([0, 0, 0, 5, 5, 5]).changeRatio).toBeNull();
  });
});

describe('summarize', () => {
  it('sums the per-bucket error counts the server reports', () => {
    // Disjoint buckets: the sum IS the window total. Before the server counted
    // per bucket, each 10s sample carried a 60s trailing window and this sum
    // reported roughly six times the traffic actually served.
    const summary = summarize([
      sample({ reqs: 10, errs: 1 }),
      sample({ reqs: 10, errs: 0 }),
      sample({ reqs: 10, errs: 2 }),
    ]);
    expect(summary.totalRequests).toBe(30);
    expect(summary.totalErrors).toBe(3);
    expect(summary.successRatio).toBeCloseTo(27 / 30);
  });

  it('falls back to the sampled rate when a server reports no error count', () => {
    const summary = summarize([
      { ...sample({ reqs: 100, errorRate: 0.1 }), errs: undefined as unknown as number },
    ]);
    expect(summary.totalErrors).toBe(10);
  });

  it('totals errors by count, not by averaging the per-sample rates', () => {
    // 100 reqs with 10 errors + 900 clean reqs is 10 errors overall. Averaging
    // the two sampled rates would call it 5%.
    const summary = summarize([
      sample({ reqs: 100, errs: 10, errorRate: 0.1 }),
      sample({ reqs: 900, errs: 0, errorRate: 0 }),
    ]);
    expect(summary.totalRequests).toBe(1000);
    expect(summary.totalErrors).toBe(10);
    expect(summary.successRatio).toBeCloseTo(0.99);
  });

  it('calls an empty window fully successful rather than dividing by zero', () => {
    expect(summarize([]).successRatio).toBe(1);
    expect(summarize([]).totalRequests).toBe(0);
  });
});

describe('buildInsights', () => {
  const healthy = summarize([sample({}), sample({}), sample({})]);

  it('says so when nothing is wrong', () => {
    const insights = buildInsights({ summary: healthy });
    expect(insights).toHaveLength(1);
    expect(insights[0]!.id).toBe('healthy');
  });

  it('escalates a 5% error rate to critical', () => {
    const summary = summarize([sample({ reqs: 100, errs: 6, errorRate: 0.06 })]);
    const errorInsight = buildInsights({ summary }).find(insight => insight.id === 'error-rate');
    expect(errorInsight?.level).toBe('critical');
  });

  it('sorts the worst finding first', () => {
    const summary = summarize([
      sample({ reqs: 100, errs: 20, errorRate: 0.2 }),
      sample({ reqs: 100, errs: 20, errorRate: 0.2 }),
      sample({ reqs: 100, errs: 20, errorRate: 0.2 }),
    ]);
    const insights = buildInsights({ summary, cacheHitRatioPct: 92 });
    expect(insights[0]!.level).toBe('critical');
    expect(insights.map(insight => insight.id)).toContain('cache-hit');
  });

  it('flags a climbing p95 even while the error rate is clean', () => {
    const summary = summarize([
      sample({ p95: 50 }), sample({ p95: 50 }), sample({ p95: 50 }),
      sample({ p95: 150 }), sample({ p95: 300 }), sample({ p95: 400 }),
    ]);
    const latency = buildInsights({ summary }).find(insight => insight.id === 'latency-trend');
    expect(latency?.level).toBe('critical');
  });
});

describe('summarize typicalP95', () => {
  it('ignores idle buckets, so an idle last minute does not read as 0ms', () => {
    const summary = summarize([
      sample({ reqs: 60, p95: 100 }),
      sample({ reqs: 30, p95: 300 }),
      sample({ reqs: 0, rps: 0, p95: 0 }),
    ]);
    expect(summary.typicalP95).toBe(200);
    expect(summary.peakP95).toBe(300);
  });

  it('is null when no bucket carried traffic', () => {
    expect(summarize([sample({ reqs: 0, rps: 0, p95: 0 })]).typicalP95).toBeNull();
    expect(summarize([]).typicalP95).toBeNull();
  });
});
