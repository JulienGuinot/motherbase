import { getErrorMessage } from '@/shared/lib/errors';
import { useProjectId } from '@/shared/hooks/useRouteParam';
import type React from 'react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Gauge, Zap, Database, HardDrive, Activity, Terminal, Lightbulb } from 'lucide-react';
import { logsApi } from '@/features/logs/api/logs.api';
import { useToast } from '@/shared/lib/toast';
import { formatBytes, formatMs } from '@/shared/lib/format';
import { EmptyState } from '@/shared/ui/EmptyState';
import { CodeBlock } from '@/shared/ui/CodeBlock';
import { IndexAdvisorModal } from '@/features/logs/components/IndexAdvisorModal';
import type {
  PerformanceReport,
  RouteMetric,
  SlowQueriesReport,
  SlowQueryMetric,
  TableScanInsight,
  UnusedIndexInsight,
  ActiveQueryInsight,
} from '@/features/logs/types';

// The performance tab: a panel composed of several private table sections. They
// are internal building blocks, so they live beside the panel that owns them.

function PerformanceSection({
  icon: Icon,
  title,
  meta,
  children,
}: {
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  title: string;
  meta?: string | number;
  children: React.ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b hairline px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon size={14} style={{ color: 'var(--text-mute)' }} />
          <span className="text-[13px]" style={{ fontWeight: 600 }}>{title}</span>
        </div>
        {meta !== undefined && <span className="chip">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function SlowQueryTable({ title, rows }: { title: string; rows: SlowQueryMetric[] }) {
  const navigate = useRouter();
  const id = useProjectId();
  const openInSql = (query: string) => navigate.push(`/p/${id}/sql?q=${encodeURIComponent(query)}`);
  const [advising, setAdvising] = useState<string | null>(null);

  return (
    <div className="min-w-0 border-t hairline xl:border-t-0 xl:border-l first:xl:border-l-0">
      <div className="border-b hairline px-4 py-2">
        <span className="label">{title}</span>
      </div>
      {!rows.length ? (
        <EmptyState title="No slow queries" description="Nothing in pg_stat_statements crossed the slow threshold in this window." />
      ) : (
        <div className="overflow-x-auto">
          <table className="console w-full">
            <thead>
              <tr>
                <th>Query</th>
                <th>Calls</th>
                <th>Mean</th>
                <th>Total</th>
                <th>Rows</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={`${title}-${i}-${row.query}`}>
                  <td className="max-w-[520px] whitespace-pre-wrap break-all">
                    <span className="mono text-[11px]">{row.query}</span>
                  </td>
                  <td>{row.calls.toLocaleString()}</td>
                  <td>{formatMs(row.meanExecTimeMs)}</td>
                  <td>{formatMs(row.totalExecTimeMs)}</td>
                  <td>{row.rows.toLocaleString()}</td>
                  <td className="whitespace-nowrap text-right">
                    <button
                      onClick={() => setAdvising(row.query)}
                      className="btn btn-ghost"
                      title="Index advisor"
                    >
                      <Lightbulb size={13} />
                    </button>
                    <button
                      onClick={() => openInSql(row.query)}
                      className="btn btn-ghost"
                      title="Open in SQL editor"
                    >
                      <Terminal size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {advising && <IndexAdvisorModal query={advising} onClose={() => setAdvising(null)} />}
    </div>
  );
}

/** Also rendered on Observability > Query Performance, Supabase's home for these rows. */
export function SlowQueriesSection({ slowQueries }: { slowQueries: SlowQueriesReport }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [enabling, setEnabling] = useState(false);

  const enableStatStatements = async () => {
    setEnabling(true);
    try {
      await logsApi.enablePgStatStatements();
      toast.push({ kind: 'success', title: 'pg_stat_statements enabled' });
      qc.invalidateQueries({ queryKey: ['performance'] });
    } catch (err) {
      toast.push({
        kind: 'error',
        title: 'Could not enable pg_stat_statements',
        message:
          getErrorMessage(err) ??
          'The database must be started with shared_preload_libraries=pg_stat_statements, then restarted.',
      });
    } finally {
      setEnabling(false);
    }
  };

  if (!slowQueries.available) {
    return (
      <PerformanceSection icon={Database} title="Slow SQL queries" meta="extension off">
        <div className="space-y-3 p-4 text-[12px]" style={{ color: 'var(--text-mute)' }}>
          <p>
            pg_stat_statements is not enabled: query timing insights are unavailable.
            {slowQueries.reason ? ` (${slowQueries.reason})` : ''}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={enabling}
            onClick={enableStatStatements}
          >
            <Zap size={13} /> {enabling ? 'Enabling…' : 'Enable pg_stat_statements'}
          </button>
          <div className="space-y-2 text-[11px]" style={{ color: 'var(--text-mute)' }}>
            <p>The button runs, as the database owner:</p>
            <CodeBlock
              value="CREATE EXTENSION pg_stat_statements;"
              label="SQL"
              language="sql"
              size="sm"
              maxHeight={120}
            />
            <p>
              That only works if the server was started with the library preloaded. Add{' '}
              <span className="mono">shared_preload_libraries=pg_stat_statements</span> to postgresql.conf (or the
              container command) and restart Postgres, since it is not a reloadable setting. The compose files shipped
              with this project already set it; recreate the database container and try again.
            </p>
          </div>
        </div>
      </PerformanceSection>
    );
  }

  const total = slowQueries.byMean.length + slowQueries.byTotal.length;
  return (
    <PerformanceSection icon={Database} title="Slow SQL queries" meta={`${total} rows`}>
      <div className="grid gap-0 xl:grid-cols-2">
        <SlowQueryTable title="By mean time" rows={slowQueries.byMean} />
        <SlowQueryTable title="By total time" rows={slowQueries.byTotal} />
      </div>
    </PerformanceSection>
  );
}

function SlowHttpSection({ routes }: { routes: RouteMetric[] }) {
  return (
    <PerformanceSection icon={Gauge} title="Slow HTTP routes" meta={routes.length}>
      {!routes.length ? (
        <EmptyState title="No slow routes" description="Every sampled route responded inside the threshold." />
      ) : (
        <div className="overflow-x-auto">
          <table className="console w-full">
            <thead>
              <tr>
                <th>Route</th>
                <th>Slow</th>
                <th>Avg</th>
                <th>P95</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {routes.slice(0, 10).map(route => (
                <tr key={route.route}>
                  <td className="max-w-[420px] whitespace-pre-wrap break-all"><span className="mono text-[11px]">{route.route}</span></td>
                  <td style={{ color: 'var(--amber)' }}>{route.slow}</td>
                  <td>{formatMs(route.avgMs)}</td>
                  <td>{formatMs(route.p95Ms)}</td>
                  <td>{route.count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PerformanceSection>
  );
}

function CacheMini({ label, value }: { label: string; value: number }) {
  return (
    <div className="border hairline p-3" style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
      <div className="tabular-nums text-[18px]" style={{ fontWeight: 600 }}>{value.toLocaleString()}</div>
      <div className="label mt-2">{label}</div>
    </div>
  );
}

function CacheHitSection({ ratio }: { ratio: PerformanceReport['cacheHitRatio'] }) {
  const value = ratio.ratioPct;
  const color = value == null ? 'var(--text-mute)' : value < 90 ? 'var(--danger)' : value < 98 ? 'var(--amber)' : 'var(--green)';
  return (
    <PerformanceSection icon={HardDrive} title="Cache hit ratio" meta={value == null ? 'no blocks' : `${value.toFixed(2)}%`}>
      <div className="grid gap-3 p-4 sm:grid-cols-3">
        <div className="sm:col-span-1">
          <div className="tabular-nums text-[48px] leading-none" style={{ color, fontWeight: 600, letterSpacing: '-0.01em' }}>
            {value == null ? '--' : `${value.toFixed(1)}%`}
          </div>
          <div className="label mt-2">heap cache</div>
        </div>
        <CacheMini label="Hits" value={ratio.heapBlocksHit} />
        <CacheMini label="Reads" value={ratio.heapBlocksRead} />
      </div>
    </PerformanceSection>
  );
}

function TableScanTable({ rows, compact }: { rows: TableScanInsight[]; compact?: boolean }) {
  return (
    <div className="overflow-x-auto border hairline" style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
      <table className="console w-full">
        <thead>
          <tr>
            <th>Table</th>
            <th>Seq</th>
            <th>Idx</th>
            <th>Live</th>
            <th>Dead</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={`${compact ? 'bloat' : 'scan'}-${row.schema}-${row.table}`}>
              <td><span className="mono text-[11px]">{row.schema}.{row.table}</span></td>
              <td>{row.seqScan.toLocaleString()}</td>
              <td>{row.idxScan.toLocaleString()}</td>
              <td>{row.liveRows.toLocaleString()}</td>
              <td style={{ color: row.needsVacuum ? 'var(--amber)' : undefined }}>{row.deadRows.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableScanSection({ missing, bloat }: { missing: TableScanInsight[]; bloat: TableScanInsight[] }) {
  return (
    <PerformanceSection icon={Database} title="Missing-index candidates" meta={missing.length}>
      {!missing.length && !bloat.length ? (
        <EmptyState title="No scan or vacuum candidates" description="No table is doing enough sequential scanning or carrying enough dead rows to flag." />
      ) : (
        <div className="space-y-4 p-4">
          {missing.length > 0 && <TableScanTable rows={missing.slice(0, 12)} />}
          {bloat.length > 0 && (
            <div className="border-t hairline pt-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="label">Vacuum candidates</span>
                <span className="chip">{bloat.length}</span>
              </div>
              <TableScanTable rows={bloat.slice(0, 8)} compact />
            </div>
          )}
        </div>
      )}
    </PerformanceSection>
  );
}

function UnusedIndexesSection({ indexes }: { indexes: UnusedIndexInsight[] }) {
  return (
    <PerformanceSection icon={HardDrive} title="Unused indexes" meta={indexes.length}>
      {!indexes.length ? (
        <EmptyState title="No unused indexes" description="Every non-unique index on this database is being read." />
      ) : (
        <div className="overflow-x-auto">
          <table className="console w-full">
            <thead>
              <tr>
                <th>Index</th>
                <th>Table</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {indexes.slice(0, 15).map(index => (
                <tr key={`${index.schema}-${index.index}`}>
                  <td className="max-w-[280px] whitespace-pre-wrap break-all"><span className="mono text-[11px]">{index.index}</span></td>
                  <td><span className="mono text-[11px]">{index.schema}.{index.table}</span></td>
                  <td>{formatBytes(index.sizeBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PerformanceSection>
  );
}

function formatAge(sec: number): string {
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m`;
  return `${Math.round(sec)}s`;
}

function ActiveQueriesSection({ queries }: { queries: ActiveQueryInsight[] }) {
  return (
    <PerformanceSection icon={Activity} title="Active queries" meta={queries.length}>
      {!queries.length ? (
        <EmptyState title="Nothing long-running" description="No query is currently held open, beyond the metrics collector itself." />
      ) : (
        <div className="overflow-x-auto">
          <table className="console w-full">
            <thead>
              <tr>
                <th>Age</th>
                <th>PID</th>
                <th>User</th>
                <th>Client</th>
                <th>Query</th>
              </tr>
            </thead>
            <tbody>
              {queries.map(query => (
                <tr key={`${query.pid}-${query.query}`}>
                  <td>{formatAge(query.ageSec)}</td>
                  <td>{query.pid}</td>
                  <td><span className="mono text-[11px]">{query.user}</span></td>
                  <td className="max-w-[180px] whitespace-pre-wrap break-all">
                    <span className="mono text-[11px]">{query.clientAddr ?? query.applicationName ?? '-'}</span>
                  </td>
                  <td className="max-w-[620px] whitespace-pre-wrap break-all">
                    <span className="mono text-[11px]">{query.query}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PerformanceSection>
  );
}

export function PerformancePanel({ report, loading, error }: { report?: PerformanceReport; loading: boolean; error: boolean }) {
  if (loading) {
    return (
      <section className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="shimmer card h-36" />)}
      </section>
    );
  }

  if (error) {
    return (
      <section className="card p-5 text-[12px]" style={{ color: 'var(--danger)' }}>
        Performance metrics unavailable.
      </section>
    );
  }

  if (!report) return null;

  return (
    <section className="space-y-3">
      <SlowQueriesSection slowQueries={report.slowQueries} />
      <div className="grid gap-3 xl:grid-cols-[1.1fr_0.9fr]">
        <SlowHttpSection routes={report.slowHttpRoutes} />
        <CacheHitSection ratio={report.cacheHitRatio} />
      </div>
      <div className="grid gap-3 xl:grid-cols-[1fr_1fr]">
        <TableScanSection missing={report.missingIndexCandidates} bloat={report.bloatCandidates} />
        <UnusedIndexesSection indexes={report.unusedIndexes} />
      </div>
      <ActiveQueriesSection queries={report.activeQueries} />
      <p className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
        Performance scan: {new Date(report.ranAt).toLocaleString()}
      </p>
    </section>
  );
}
