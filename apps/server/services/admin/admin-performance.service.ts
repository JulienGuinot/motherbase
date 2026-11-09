import type { PrismaClient } from '@prisma/client';
import { shieldTelemetry, type RouteMetric } from '../../lib/shield-telemetry';

const PG_STAT_STATEMENTS_DISABLED_REASON = 'pg_stat_statements not enabled';

interface SlowQueryMetric {
  query: string;
  calls: number;
  meanExecTimeMs: number;
  totalExecTimeMs: number;
  rows: number;
}

export type SlowQueriesReport =
  | { available: false; reason: typeof PG_STAT_STATEMENTS_DISABLED_REASON }
  | { available: true; byMean: SlowQueryMetric[]; byTotal: SlowQueryMetric[] };

export interface TableScanInsight {
  schema: string;
  table: string;
  seqScan: number;
  idxScan: number;
  liveRows: number;
  deadRows: number;
  missingIndexCandidate: boolean;
  needsVacuum: boolean;
}

export interface UnusedIndexInsight {
  schema: string;
  table: string;
  index: string;
  idxScan: number;
  sizeBytes: number;
}

export interface CacheHitRatio {
  ratioPct: number | null;
  heapBlocksHit: number;
  heapBlocksRead: number;
}

export interface ActiveQueryInsight {
  pid: number;
  user: string;
  applicationName: string | null;
  clientAddr: string | null;
  ageSec: number;
  query: string;
}

export interface PerformanceReport {
  ranAt: string;
  slowQueries: SlowQueriesReport;
  tableScans: TableScanInsight[];
  missingIndexCandidates: TableScanInsight[];
  bloatCandidates: TableScanInsight[];
  unusedIndexes: UnusedIndexInsight[];
  cacheHitRatio: CacheHitRatio;
  activeQueries: ActiveQueryInsight[];
  slowHttpRoutes: RouteMetric[];
}

type QueryRow = Record<string, unknown>;

function metricFromRow(row: QueryRow): SlowQueryMetric {
  return {
    query: String(row.query ?? ''),
    calls: Number(row.calls ?? 0),
    meanExecTimeMs: Number(row.mean_exec_time_ms ?? 0),
    totalExecTimeMs: Number(row.total_exec_time_ms ?? 0),
    rows: Number(row.rows ?? 0),
  };
}

function errorDetails(error: unknown): { code?: unknown; message: string } {
  if (!error || typeof error !== 'object') return { message: String(error ?? '') };
  const value = error as { code?: unknown; message?: unknown; meta?: { code?: unknown; message?: unknown } };
  return {
    code: value.meta?.code ?? value.code,
    message: String(value.meta?.message ?? value.message ?? '').toLowerCase(),
  };
}

/** Collects database performance insights without coupling them to admin CRUD. */
export class AdminPerformanceService {
  constructor(private readonly prisma: PrismaClient) {}

  async report(): Promise<PerformanceReport> {
    const [slowQueries, tableScans, unusedIndexes, cacheHitRatio, activeQueries] = await Promise.all([
      this.slowQueries(),
      this.tableScanInsights(),
      this.unusedIndexes(),
      this.cacheHitRatio(),
      this.activeQueries(),
    ]);

    return {
      ranAt: new Date().toISOString(),
      slowQueries,
      tableScans,
      missingIndexCandidates: tableScans.filter(table => table.missingIndexCandidate),
      bloatCandidates: tableScans.filter(table => table.needsVacuum),
      unusedIndexes,
      cacheHitRatio,
      activeQueries,
      slowHttpRoutes: shieldTelemetry.summarize().routes.filter(route => route.slow > 0),
    };
  }

  private async slowQueries(): Promise<SlowQueriesReport> {
    const extension = await this.prisma.$queryRawUnsafe<Array<{ enabled: boolean }>>(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS enabled`
    );
    if (!extension[0]?.enabled) return { available: false, reason: PG_STAT_STATEMENTS_DISABLED_REASON };

    const selectSql = `
      SELECT
        LEFT(regexp_replace(query, '[[:space:]]+', ' ', 'g'), 200) AS query,
        calls::float8 AS calls,
        ROUND(mean_exec_time::numeric, 2)::float8 AS mean_exec_time_ms,
        ROUND(total_exec_time::numeric, 2)::float8 AS total_exec_time_ms,
        rows::float8 AS rows
      FROM pg_stat_statements
      WHERE query NOT ILIKE '%pg_stat_statements%'
    `;

    try {
      const [byMean, byTotal] = await Promise.all([
        this.prisma.$queryRawUnsafe<QueryRow[]>(`${selectSql} ORDER BY mean_exec_time DESC LIMIT 15`),
        this.prisma.$queryRawUnsafe<QueryRow[]>(`${selectSql} ORDER BY total_exec_time DESC LIMIT 15`),
      ]);
      return {
        available: true,
        byMean: byMean.map(metricFromRow),
        byTotal: byTotal.map(metricFromRow),
      };
    } catch (error: unknown) {
      if (this.isPgStatStatementsUnavailable(error)) {
        return { available: false, reason: PG_STAT_STATEMENTS_DISABLED_REASON };
      }
      throw error;
    }
  }

  private async tableScanInsights(): Promise<TableScanInsight[]> {
    const rows = await this.prisma.$queryRawUnsafe<QueryRow[]>(`
      SELECT
        schemaname AS "schema",
        relname AS "table",
        seq_scan::float8 AS "seqScan",
        idx_scan::float8 AS "idxScan",
        n_live_tup::float8 AS "liveRows",
        n_dead_tup::float8 AS "deadRows",
        (seq_scan >= 50 AND n_live_tup >= 1000 AND seq_scan > idx_scan) AS "missingIndexCandidate",
        (n_dead_tup >= GREATEST(1000, n_live_tup * 0.2)) AS "needsVacuum"
      FROM pg_stat_user_tables
      ORDER BY
        (seq_scan >= 50 AND n_live_tup >= 1000 AND seq_scan > idx_scan) DESC,
        (n_dead_tup >= GREATEST(1000, n_live_tup * 0.2)) DESC,
        (seq_scan * GREATEST(n_live_tup, 1)) DESC,
        n_dead_tup DESC
      LIMIT 50
    `);

    return rows.map(row => ({
      schema: String(row.schema ?? ''),
      table: String(row.table ?? ''),
      seqScan: Number(row.seqScan ?? 0),
      idxScan: Number(row.idxScan ?? 0),
      liveRows: Number(row.liveRows ?? 0),
      deadRows: Number(row.deadRows ?? 0),
      missingIndexCandidate: Boolean(row.missingIndexCandidate),
      needsVacuum: Boolean(row.needsVacuum),
    }));
  }

  private async unusedIndexes(): Promise<UnusedIndexInsight[]> {
    const rows = await this.prisma.$queryRawUnsafe<QueryRow[]>(`
      SELECT
        s.schemaname AS "schema",
        s.relname AS "table",
        s.indexrelname AS "index",
        s.idx_scan::float8 AS "idxScan",
        pg_relation_size(s.indexrelid)::float8 AS "sizeBytes"
      FROM pg_stat_user_indexes s
      JOIN pg_index i ON i.indexrelid = s.indexrelid
      WHERE s.idx_scan = 0
        AND NOT i.indisprimary
        AND NOT i.indisunique
      ORDER BY pg_relation_size(s.indexrelid) DESC
      LIMIT 50
    `);

    return rows.map(row => ({
      schema: String(row.schema ?? ''),
      table: String(row.table ?? ''),
      index: String(row.index ?? ''),
      idxScan: Number(row.idxScan ?? 0),
      sizeBytes: Number(row.sizeBytes ?? 0),
    }));
  }

  private async cacheHitRatio(): Promise<CacheHitRatio> {
    const rows = await this.prisma.$queryRawUnsafe<QueryRow[]>(`
      SELECT
        CASE
          WHEN COALESCE(SUM(heap_blks_hit), 0) + COALESCE(SUM(heap_blks_read), 0) = 0 THEN NULL
          ELSE ROUND(
            (SUM(heap_blks_hit)::numeric / NULLIF(SUM(heap_blks_hit) + SUM(heap_blks_read), 0)) * 100,
            2
          )::float8
        END AS "ratioPct",
        COALESCE(SUM(heap_blks_hit), 0)::float8 AS "heapBlocksHit",
        COALESCE(SUM(heap_blks_read), 0)::float8 AS "heapBlocksRead"
      FROM pg_statio_user_tables
    `);
    const row = rows[0] ?? {};

    return {
      ratioPct: row.ratioPct == null ? null : Number(row.ratioPct),
      heapBlocksHit: Number(row.heapBlocksHit ?? 0),
      heapBlocksRead: Number(row.heapBlocksRead ?? 0),
    };
  }

  private async activeQueries(): Promise<ActiveQueryInsight[]> {
    const rows = await this.prisma.$queryRawUnsafe<QueryRow[]>(`
      SELECT
        pid::int AS pid,
        usename AS "user",
        NULLIF(application_name, '') AS "applicationName",
        client_addr::text AS "clientAddr",
        EXTRACT(EPOCH FROM (now() - query_start))::float8 AS "ageSec",
        LEFT(regexp_replace(query, '[[:space:]]+', ' ', 'g'), 200) AS query
      FROM pg_stat_activity
      WHERE state = 'active'
        AND pid <> pg_backend_pid()
        AND query_start IS NOT NULL
        AND query NOT ILIKE '%pg_stat_activity%'
        AND query NOT ILIKE '%pg_stat_statements%'
      ORDER BY query_start ASC
      LIMIT 20
    `);

    return rows.map(row => ({
      pid: Number(row.pid ?? 0),
      user: String(row.user ?? ''),
      applicationName: row.applicationName == null ? null : String(row.applicationName),
      clientAddr: row.clientAddr == null ? null : String(row.clientAddr),
      ageSec: Number(row.ageSec ?? 0),
      query: String(row.query ?? ''),
    }));
  }

  private isPgStatStatementsUnavailable(error: unknown): boolean {
    const { code, message } = errorDetails(error);
    return (
      code === '42P01' ||
      (message.includes('pg_stat_statements') &&
        (message.includes('does not exist') ||
          message.includes('shared_preload_libraries') ||
          message.includes('not loaded')))
    );
  }
}
