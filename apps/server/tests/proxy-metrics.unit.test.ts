import { describe, expect, it } from 'vitest';
import { ProxyMetrics } from '../console/services/proxy-metrics.service';

describe('ProxyMetrics', () => {
  it('counts requests per project and route kind', () => {
    const metrics = new ProxyMetrics(() => 1000);
    metrics.record('proj_a', 'rest');
    metrics.record('proj_a', 'rest');
    metrics.record('proj_a', 'edge');
    metrics.record('proj_b', 'admin');

    const snapshot = metrics.snapshot();
    expect(snapshot).toEqual([
      { projectId: 'proj_a', rest: 2, edge: 1, admin: 0, total: 3, lastAt: 1000 },
      { projectId: 'proj_b', rest: 0, edge: 0, admin: 1, total: 1, lastAt: 1000 },
    ]);
  });

  it('sorts busiest project first', () => {
    const metrics = new ProxyMetrics();
    metrics.record('quiet', 'rest');
    metrics.record('busy', 'rest');
    metrics.record('busy', 'edge');

    expect(metrics.snapshot().map(r => r.projectId)).toEqual(['busy', 'quiet']);
  });

  it('reset clears all counters', () => {
    const metrics = new ProxyMetrics();
    metrics.record('proj_a', 'rest');
    metrics.reset();
    expect(metrics.snapshot()).toEqual([]);
  });
});
