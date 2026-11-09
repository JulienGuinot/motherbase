import { Client } from 'pg';
import BaseContext from '../../context/base-context';
import { HttpException } from '../../exceptions/http-exception';
import { APPLICATION_NAME } from '../../lib/instance';
import { absorbConnectionErrors } from '../../lib/errors';
import { quoteIdentCatalog } from '../../lib/sql-identifier';
import { execDdl } from './schema-ddl';
import type { AdvisorFinding } from './advisor.service';

/**
 * Supabase's index advisor: which index would make a query cheaper.
 *
 * `index_advisor(query)` (vendored from supabase/index_advisor, see
 * deploy/postgres/index_advisor) prepares the query, creates a hypothetical
 * index with hypopg on every unindexed column, re-plans, and reports the
 * indexes the new plan actually used with the cost before and after. Nothing is
 * built and the query never runs: it is EXPLAIN over indexes that do not exist.
 *
 * Both extensions ship in the Postgres image from this version on. A database
 * running an older image has neither control file, and every entry point here
 * says so, with the rebuild that fixes it, instead of a bare Postgres error.
 */

export interface IndexAdvisorStatus {
  /** hypopg and index_advisor are both present in this database image. */
  available: boolean;
  installed: boolean;
  /** What to do when `available` is false. */
  hint: string | null;
}

export interface IndexAdvice {
  startupCostBefore: number | null;
  startupCostAfter: number | null;
  totalCostBefore: number | null;
  totalCostAfter: number | null;
  /** `CREATE INDEX ...` statements, ready to run. Empty when no index helps. */
  indexStatements: string[];
  errors: string[];
  /** Relative drop in total planned cost, 0 to 100, or null when either side is missing. */
  improvementPct: number | null;
}

export interface SlowQuerySuggestion {
  query: string;
  calls: number;
  totalExecTimeMs: number;
  advice: IndexAdvice;
}

export const IMAGE_MISSING_HINT =
  'The index advisor needs the hypopg and index_advisor extensions, which this database image does not have: it ' +
  'was built before they were added. Rebuild the Postgres image from deploy/postgres.Dockerfile ' +
  '(deploy/build-images.sh, or `docker compose build db`), recreate the database container, then enable it again.';

/** How long one advice may take. Planning a query with every hypothetical index is quick, but not free. */
const ADVICE_TIMEOUT_MS = 15_000;

/** Slow statements worth advising on: DML and reads over user tables, not the catalog reads this server makes. */
const ADVISABLE_SLOW_QUERIES_SQL = `
  SELECT query, calls::float8 AS calls, total_exec_time::float8 AS total_exec_time_ms
    FROM pg_stat_statements
   WHERE query ~* '^\\s*(select|with|update|delete)\\s'
     AND query !~* '(pg_catalog|information_schema|pg_stat|pg_class|pg_namespace|index_advisor|hypopg)'
   ORDER BY total_exec_time DESC
   LIMIT $1`;

const num = (value: unknown): number | null => (value == null ? null : Number(value));

export function toAdvice(row: Record<string, unknown>): IndexAdvice {
  const before = num(row.total_cost_before);
  const after = num(row.total_cost_after);
  return {
    startupCostBefore: num(row.startup_cost_before),
    startupCostAfter: num(row.startup_cost_after),
    totalCostBefore: before,
    totalCostAfter: after,
    indexStatements: (row.index_statements as string[] | null) ?? [],
    errors: (row.errors as string[] | null) ?? [],
    improvementPct:
      before != null && after != null && before > 0 ? Math.round(((before - after) / before) * 1000) / 10 : null,
  };
}

/**
 * One advisor finding per slow query an index would help. A small gain is still
 * reported, as info: the advisor's job is to show it, and the numbers let the
 * operator weigh it. A large one (half the planned cost or more) is a warning.
 */
export function indexSuggestionFindings(suggestions: SlowQuerySuggestion[]): AdvisorFinding[] {
  return suggestions
    .filter(s => s.advice.indexStatements.length > 0)
    .map(s => ({
      id: 'perf_index_suggestion',
      category: 'performance' as const,
      level: (s.advice.improvementPct ?? 0) >= 50 ? ('warning' as const) : ('info' as const),
      title: 'Index suggestion for a slow query',
      detail:
        `A query run ${s.calls.toLocaleString('en-US')} times (${Math.round(s.totalExecTimeMs)} ms in total) ` +
        `would plan at ${s.advice.totalCostAfter} instead of ${s.advice.totalCostBefore} ` +
        `(${s.advice.improvementPct ?? 0}% cheaper) with ${s.advice.indexStatements.length === 1 ? 'this index' : 'these indexes'}.`,
      target: s.query.length > 160 ? `${s.query.slice(0, 157)}...` : s.query,
      remediation: s.advice.indexStatements.map(sql => `${sql};`).join('\n'),
    }));
}

export class IndexAdvisorService extends BaseContext {
  async status(): Promise<IndexAdvisorStatus> {
    const [row] = await this.di.prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
      SELECT count(*) FILTER (WHERE name IN ('hypopg', 'index_advisor'))::int AS available,
             count(*) FILTER (WHERE name = 'index_advisor' AND installed_version IS NOT NULL)::int AS installed
        FROM pg_available_extensions
    `);
    const available = Number(row?.available) === 2;
    return { available, installed: Number(row?.installed) === 1, hint: available ? null : IMAGE_MISSING_HINT };
  }

  async enable(): Promise<IndexAdvisorStatus> {
    if (!(await this.status()).available) throw new HttpException(IMAGE_MISSING_HINT, 400);
    await execDdl(this.di.prisma, 'CREATE EXTENSION IF NOT EXISTS hypopg');
    await execDdl(this.di.prisma, 'CREATE EXTENSION IF NOT EXISTS index_advisor');
    return this.status();
  }

  async advise(query: string): Promise<IndexAdvice> {
    const status = await this.status();
    if (!status.installed) {
      throw new HttpException(
        status.available ? 'The index advisor is not enabled for this project. Enable it first.' : IMAGE_MISSING_HINT,
        400,
      );
    }
    return this.withAdvisorClient(client => this.adviseOn(client, query));
  }

  /**
   * Advice for the slowest advisable statements in pg_stat_statements. Empty,
   * never an error, when either extension is missing: this feeds the advisor
   * report, which must not fail because one of its sources is off.
   */
  async suggestForSlowQueries(limit = 5): Promise<SlowQuerySuggestion[]> {
    try {
      if (!(await this.status()).installed) return [];
      return await this.withAdvisorClient(async client => {
        const { rows } = await client.query(ADVISABLE_SLOW_QUERIES_SQL, [limit]);
        const out: SlowQuerySuggestion[] = [];
        for (const row of rows) {
          const advice = await this.adviseOn(client, String(row.query));
          out.push({ query: String(row.query), calls: Number(row.calls), totalExecTimeMs: Number(row.total_exec_time_ms), advice });
        }
        return out;
      });
    } catch {
      return [];
    }
  }

  private async adviseOn(client: Client, query: string): Promise<IndexAdvice> {
    const { rows: [ext] } = await client.query(
      `SELECT extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname = 'index_advisor'`,
    );
    const fn = `${quoteIdentCatalog(String(ext.schema))}.index_advisor`;
    // Its own transaction per query: index_advisor's SET LOCAL plan_cache_mode
    // and every hypothetical index end with it, and a failure in one query's
    // advice cannot poison the next.
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [String(ADVICE_TIMEOUT_MS)]);
      const { rows } = await client.query(`SELECT * FROM ${fn}($1)`, [query]);
      return toAdvice(rows[0] ?? {});
    } finally {
      await client.query('ROLLBACK');
    }
  }

  /**
   * A dedicated connection, never Prisma's pool: index_advisor runs
   * `DEALLOCATE ALL`, which would drop the prepared statements Prisma keeps on
   * whichever pooled connection it landed on.
   */
  private async withAdvisorClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = absorbConnectionErrors(
      new Client({ connectionString: process.env.DATABASE_URL, application_name: APPLICATION_NAME })
    );
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
}
