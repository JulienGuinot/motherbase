'use client';

import { useMemo, useState } from 'react';
import { BarChart3, LineChart, Plus, Share2, Trash2, X } from 'lucide-react';
import ChartCard from '@/shared/ui/charts/ChartCard';
import AreaTrend from '@/shared/ui/charts/AreaTrend';
import BarTrend from '@/shared/ui/charts/BarTrend';
import RangePicker from '@/shared/ui/RangePicker';
import { EmptyState } from '@/shared/ui/EmptyState';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { confirmDialog, promptDialog } from '@/shared/ui/ConfirmDialog';
import { RANGE_MS, type RangeKey } from '@/shared/lib/range';
import { formatClock } from '@/shared/lib/format';
import { useContent } from '@/shared/hooks/useContent';
import type { ReportChart } from '@/shared/lib/content';
import { CoverageNotice } from '@/features/logs/components/CoverageNotice';
import { useMetricsTimeseries } from '@/features/logs/hooks/useReports';
import { newChart, REPORT_METRICS, REPORT_METRIC_KEYS } from '@/features/logs/lib/report-metrics';

const isRange = (value: string | undefined): value is RangeKey => value !== undefined && value in RANGE_MS;

// Custom reports: a page of the metric charts Observability already draws,
// picked and saved by the operator. Kept by the project, private or shared
// like a SQL snippet; only the owner edits a report.
export default function ObservabilityReports() {
  const reports = useContent('report');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rangeOverride, setRangeOverride] = useState<RangeKey | null>(null);

  const report = reports.items.find(item => item.id === selectedId) ?? reports.items[0] ?? null;
  const mine = report !== null && report.ownerId === reports.operator;
  const range = rangeOverride ?? (isRange(report?.content.range) ? report.content.range : '1h');

  const seriesQ = useMetricsTimeseries(range);
  const series = useMemo(() => seriesQ.data?.samples ?? [], [seriesQ.data]);

  const saveCharts = (charts: ReportChart[]) =>
    report && reports.update.mutate({ id: report.id, patch: { content: { charts, range } } });

  const create = async () => {
    const name = await promptDialog({ title: 'New report', placeholder: 'API health', confirmLabel: 'Create report' });
    if (!name) return;
    reports.create.mutate({ name, content: { charts: [newChart('rps', [])], range: '1h' } }, {
      onSuccess: item => {
        setSelectedId(item.id);
        setRangeOverride(null);
      },
    });
  };

  const remove = async () => {
    if (!report) return;
    const confirmed = await confirmDialog({ title: `Delete "${report.name}"?`, confirmLabel: 'Delete report', tone: 'danger' });
    if (confirmed) reports.remove.mutate(report.id);
  };

  return (
    <PageShell width="wide">
      <PageHeader
        size="sm"
        title="Reports"
        subtitle="Compose your own page from the Observability metrics. Reports are saved with the project."
        actions={
          <>
            <RangePicker
              value={range}
              onChange={next => {
                setRangeOverride(next);
                if (mine) reports.update.mutate({ id: report.id, patch: { content: { charts: report.content.charts, range: next } } });
              }}
            />
            <button className="btn btn-primary" onClick={create}><Plus size={12} /> New report</button>
          </>
        }
      />

      {reports.items.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {reports.items.map(item => (
            <button
              key={item.id}
              className="chip"
              aria-pressed={item.id === report?.id}
              style={item.id === report?.id ? { borderColor: 'var(--accent)', color: 'var(--text)' } : undefined}
              onClick={() => {
                setSelectedId(item.id);
                setRangeOverride(null);
              }}
            >
              {item.name}{item.visibility === 'project' ? ' · shared' : ''}
            </button>
          ))}
        </div>
      )}

      {!report ? (
        <EmptyState
          className="card"
          size="md"
          title={reports.isLoading ? 'Loading reports…' : 'No reports yet'}
          description="Create one, then add the charts you want on it."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px]" style={{ fontWeight: 600 }}>{report.name}</h3>
            {mine ? (
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <select
                  className="input w-auto"
                  aria-label="Add a chart"
                  value=""
                  onChange={event => event.target.value && saveCharts([...report.content.charts, newChart(event.target.value, report.content.charts)])}
                >
                  <option value="">Add a chart…</option>
                  {REPORT_METRIC_KEYS.map(key => <option key={key} value={key}>{REPORT_METRICS[key].label}</option>)}
                </select>
                <button
                  className="btn btn-ghost"
                  onClick={() => reports.update.mutate({ id: report.id, patch: { visibility: report.visibility === 'project' ? 'user' : 'project' } })}
                >
                  <Share2 size={12} /> {report.visibility === 'project' ? 'Unshare' : 'Share'}
                </button>
                <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={remove} aria-label="Delete report">
                  <Trash2 size={12} />
                </button>
              </div>
            ) : (
              <span className="chip ml-auto text-[10px]">shared by a teammate, read-only</span>
            )}
          </div>

          <CoverageNotice coverage={seriesQ.data?.coverage} />

          {report.content.charts.length === 0 ? (
            <EmptyState className="card" size="md" title="Empty report" description="Add a chart from the menu above." />
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {report.content.charts.map(chart => {
                const metric = REPORT_METRICS[chart.metric];
                // A metric dropped from the catalog since the report was saved.
                if (!metric) return null;
                const last = series[series.length - 1];
                return (
                  <ChartCard
                    key={chart.id}
                    title={chart.title ?? metric.label}
                    value={last ? metric.format(last[metric.field] as number) : undefined}
                    hint={mine ? undefined : range}
                  >
                    {mine && (
                      <div className="-mt-1 mb-2 flex justify-end gap-1">
                        <button
                          className="btn btn-ghost"
                          title={chart.chart === 'line' ? 'Show as bars' : 'Show as a line'}
                          onClick={() => saveCharts(report.content.charts.map(c => (c.id === chart.id ? { ...c, chart: c.chart === 'line' ? 'bar' : 'line' } : c)))}
                        >
                          {chart.chart === 'line' ? <BarChart3 size={12} /> : <LineChart size={12} />}
                        </button>
                        <button
                          className="btn btn-ghost"
                          aria-label={`Remove ${metric.label}`}
                          onClick={() => saveCharts(report.content.charts.filter(c => c.id !== chart.id))}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    )}
                    {chart.chart === 'bar' ? (
                      <BarTrend data={series} xKey="at" yKey={metric.field} color={metric.color} labelFormat={formatClock} format={metric.format} />
                    ) : (
                      <AreaTrend data={series} xKey="at" yKey={metric.field} color={metric.color} labelFormat={formatClock} format={metric.format} />
                    )}
                  </ChartCard>
                );
              })}
            </div>
          )}
        </>
      )}
    </PageShell>
  );
}
