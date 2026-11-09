import { api } from '@/shared/lib/api';
import type {
  LogEntry,
  LogPage,
  LogQueryFilters,
  MetricsCoverage,
  ShieldReport,
  PerformanceReport,
  IndexAdvice,
  IndexAdvisorStatus,
  MetricSample,
  Stats,
} from '@/features/logs/types';

export const logsApi = {
  /**
   * Filters travel with the request.
   *
   * They used to be applied in the browser, to a list the server had already
   * cut to the newest N lines: an error with a thousand info lines after it was
   * simply not in the slice, and filtering for "error" returned nothing for a
   * line the retention had kept. The endpoint has accepted `level`, `source`
   * and `q` the whole time.
   */
  logs: (params: { limit?: number; since?: number; before?: string } & LogQueryFilters = {}) => {
    const query = new URLSearchParams({ limit: String(params.limit ?? 500) });
    // The server reads history out of the log table for anything the ring
    // buffer cannot answer, so the range has to travel with the request.
    if (params.since !== undefined) query.set('since', String(params.since));
    if (params.before) query.set('before', params.before);
    for (const level of params.levels ?? []) query.append('level', level);
    for (const source of params.sources ?? []) query.append('source', source);
    if (params.q?.trim()) query.set('q', params.q.trim());
    for (const key of ['service', 'status', 'method', 'path', 'user'] as const) {
      const value = params[key]?.trim();
      if (value) query.set(key, value);
    }
    return api.get(`/admin/logs?${query}`).then(r => {
      const data = r.data.data as Partial<LogPage> & { logs: LogEntry[] };
      return {
        logs: data.logs,
        persisted: data.persisted ?? false,
        retentionDays: data.retentionDays ?? null,
        oldestAvailable: data.oldestAvailable ?? null,
        hasMore: data.hasMore ?? false,
        nextCursor: data.nextCursor ?? null,
      } satisfies LogPage;
    });
  },
  shield: (range?: string) =>
    api.get('/admin/shield', { params: range ? { range } : undefined }).then(r => r.data.data as ShieldReport),
  performance: () => api.get('/admin/performance').then(r => r.data.data as PerformanceReport),
  /**
   * Samples AND what period they actually cover. The buffer holds about an hour;
   * the picker offers 24h, and the page used to draw the hour it got under the
   * 24h label with nothing saying the rest was missing.
   */
  metricsTimeseries: (range: string) =>
    api
      .get(`/admin/metrics/timeseries?range=${range}`)
      .then(r => r.data.data as { samples: MetricSample[]; coverage: MetricsCoverage }),
  stats: () => api.get('/admin/stats').then(r => r.data.data as Stats),
  /** Query mode: read-only SQL over the stored history (`platform.request_logs`). */
  runQuery: (sql: string) =>
    api.post('/admin/sql/readonly', { sql }).then(r => r.data.data as { columns?: string[]; rows?: Record<string, unknown>[] }),
  enablePgStatStatements: () => api.post('/admin/schema/extensions/pg_stat_statements'),
  indexAdvisorStatus: () =>
    api.get('/admin/performance/index-advisor').then(r => r.data.data as IndexAdvisorStatus),
  enableIndexAdvisor: () =>
    api.post('/admin/performance/index-advisor/enable').then(r => r.data.data as IndexAdvisorStatus),
  /** Plans the query over hypothetical indexes: nothing is built and the query never runs. */
  adviseIndexes: (query: string) =>
    api.post('/admin/performance/index-advisor', { query }).then(r => r.data.data as IndexAdvice),
};
