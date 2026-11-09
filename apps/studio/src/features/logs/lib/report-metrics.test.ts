import { describe, expect, it } from 'vitest';
import { newChart, REPORT_METRICS } from '@/features/logs/lib/report-metrics';

describe('newChart', () => {
  it('never reuses the id of a chart still on the report', () => {
    // c2 was removed earlier, so the next id by count (c3) is still taken.
    const charts = [
      { id: 'c1', metric: 'rps', chart: 'line' as const },
      { id: 'c3', metric: 'p95', chart: 'line' as const },
    ];
    expect(newChart('errors', charts)).toEqual({ id: 'c4', metric: 'errors', chart: 'line' });
    expect(newChart('errors', [])).toEqual({ id: 'c1', metric: 'errors', chart: 'line' });
  });

  it('is exposed for the metrics the mock and stored reports use', () => {
    expect(Object.keys(REPORT_METRICS)).toEqual(expect.arrayContaining(['requests', 'p95', 'errorRate']));
  });
});
