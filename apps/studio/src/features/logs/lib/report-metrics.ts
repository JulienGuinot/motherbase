import { formatMs, formatPercent } from '@/shared/lib/format';
import type { ReportChart } from '@/shared/lib/content';
import type { MetricSample } from '@/features/logs/types';

/**
 * The metrics a custom report can chart: the series the Observability pages
 * already draw, under the keys a stored report refers to them by. A report
 * keeps only the key, so this catalog can grow (or a label change) without
 * migrating anything; a key that no longer exists is skipped when drawing.
 */
export interface ReportMetric {
  label: string;
  /** Which field of a metrics sample the chart plots. */
  field: keyof MetricSample & string;
  color: string;
  format: (value: number) => string;
}

export const REPORT_METRICS: Record<string, ReportMetric> = {
  rps: { label: 'Requests / sec', field: 'rps', color: 'var(--accent)', format: v => v.toFixed(2) },
  requests: { label: 'Requests', field: 'reqs', color: 'var(--blue)', format: v => v.toLocaleString() },
  errors: { label: 'Errors', field: 'errs', color: 'var(--red)', format: v => v.toLocaleString() },
  p95: { label: 'p95 latency', field: 'p95', color: 'var(--green)', format: formatMs },
  errorRate: { label: 'Error rate', field: 'errorRate', color: 'var(--red)', format: formatPercent },
  memMb: { label: 'Memory (RSS)', field: 'memMb', color: 'var(--amber)', format: v => `${v.toFixed(0)} MB` },
};

export const REPORT_METRIC_KEYS = Object.keys(REPORT_METRICS);

export function newChart(metric: string, charts: ReportChart[]): ReportChart {
  let n = charts.length + 1;
  while (charts.some(chart => chart.id === `c${n}`)) n += 1;
  return { id: `c${n}`, metric, chart: 'line' };
}
