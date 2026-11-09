import BaseContext from '../../context/base-context';
import { errorCode, errorMessage } from '../../lib/errors';
import { formatSqlError } from '../../lib/pg-error';
import { HttpException } from '../../exceptions/http-exception';
import type { RlsContext, RlsRole } from '../../lib/rls-claims';
import { classifyStatement, isDisguisedWrite } from './sql.service';

/**
 * "What does this query return for that user?" answered by actually running it
 * as that user, rather than by reasoning about the policies.
 *
 * Three properties make that safe to expose, and all three are enforced here
 * rather than assumed:
 *
 *  1. It runs as `anon` or `authenticated` through `RlsPool`, never as the
 *     schema owner, so RLS is genuinely in force (the owner bypasses it).
 *  2. The transaction is ALWAYS rolled back, even on success. The read-only
 *     checks below are static analysis and static analysis is never complete;
 *     the rollback is the guarantee that does not depend on them.
 *  3. A statement timeout and a row cap bound the damage a hostile or merely
 *     careless query can do to the instance.
 *
 * It is still admin-guarded at the route: it executes caller-supplied SQL, and
 * the point of the feature is to see rows a given end user would see.
 */

/** Only these can be wrapped in `SELECT * FROM ( ... )`, which is how the row cap is imposed. */
const ALLOWED_LEADING_KEYWORDS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE']);

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;

interface SimulatePolicy {
  name: string;
  command: string;
  roles: string[];
  using: string | null;
  withCheck: string | null;
  /** True when this policy is one Postgres could have consulted for this role and a read. */
  applies: boolean;
}

export interface SimulateTable {
  schema: string;
  table: string;
  rlsEnabled: boolean;
  /** Table privileges this role holds. RLS is irrelevant without SELECT here. */
  privileges: string[];
  /** True when this table can only ever contribute 0 rows for this caller. */
  deniesAll: boolean;
  /**
   * Which of the two independent gates closed. They fail differently and are
   * fixed differently: a missing GRANT is an error from Postgres, a missing
   * policy is a silent empty result.
   */
  deniedBy: 'grant' | 'policy' | null;
  policies: SimulatePolicy[];
}

export interface SimulateResult {
  role: RlsRole;
  claims: Record<string, unknown>;
  columns: string[];
  rows: any[];
  rowCount: number;
  /** True when the row cap cut the result, so the caller knows it is not the whole answer. */
  truncated: boolean;
  /**
   * Set when Postgres refused the read outright (missing GRANT) rather than
   * filtering it to nothing. Returned instead of thrown: "you got an error, and
   * here is the table privilege that caused it" is the answer being asked for.
   */
  denied: { code: string; message: string } | null;
  tables: SimulateTable[];
}

export interface SimulateInput {
  sql: string;
  role?: string;
  claims?: Record<string, unknown> | string | null;
  /** Simulate as a real user: fills sub and user_role from the users table. */
  userId?: string | null;
  limit?: number;
  timeoutMs?: number;
}

export interface SimulateDiff {
  left: SimulateResult;
  right: SimulateResult;
  /** Primary-key-free comparison: rows are matched on their full JSON serialization. */
  onlyInLeft: any[];
  onlyInRight: any[];
}

function clamp(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function sanitize(value: any): any {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]));
  }
  return value;
}

/** Walk an EXPLAIN (FORMAT JSON) plan tree and collect every base relation it touches. */
function relationsInPlan(node: any, into: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) relationsInPlan(child, into);
    return;
  }
  const relation = node['Relation Name'];
  if (typeof relation === 'string') {
    into.add(`${typeof node.Schema === 'string' ? node.Schema : 'public'}.${relation}`);
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') relationsInPlan(value, into);
  }
}

export class RlsSimulatorService extends BaseContext {
  /**
   * Rejects anything that is not a single read. `classifyStatement` and
   * `isDisguisedWrite` are shared with the SQL console so the two surfaces
   * cannot drift apart on what "read" means.
   */
  private assertSingleRead(sql: string): string {
    const trimmed = (sql ?? '').trim().replace(/;\s*$/, '');
    if (!trimmed) throw new HttpException('sql is required', 400);
    // A `;` in the body means more than one statement: the wrapper below would
    // splice the tail outside the subquery, so refuse instead of guessing.
    if (trimmed.includes(';')) {
      throw new HttpException('The simulator runs a single statement. Remove the extra ";".', 400);
    }
    if (classifyStatement(trimmed) !== 'read' || isDisguisedWrite(trimmed)) {
      throw new HttpException('The simulator only runs read statements.', 400);
    }
    const leading = trimmed.split(/\s+/)[0].toUpperCase();
    if (!ALLOWED_LEADING_KEYWORDS.has(leading)) {
      throw new HttpException(
        `The simulator runs ${Array.from(ALLOWED_LEADING_KEYWORDS).join(', ')} statements, not ${leading}.`,
        400
      );
    }
    return trimmed;
  }

  /** Build the RLS context to simulate, from an explicit role/claims pair or from a real user id. */
  private async resolveContext(input: SimulateInput): Promise<RlsContext> {
    if (input.userId) {
      const user = await this.di.prisma.user.findUnique({
        where: { id: input.userId },
        select: { id: true, role: true },
      });
      if (!user) throw new HttpException(`No such user: ${input.userId}`, 404);
      return {
        role: 'authenticated',
        claims: JSON.stringify({ sub: user.id, role: 'authenticated', user_role: user.role ?? null }),
      };
    }

    const role = input.role ?? 'anon';
    if (role !== 'anon' && role !== 'authenticated') {
      throw new HttpException(`role must be anon or authenticated, got ${role}`, 400);
    }

    let claims: Record<string, unknown>;
    if (typeof input.claims === 'string') {
      try {
        claims = JSON.parse(input.claims);
      } catch {
        throw new HttpException('claims must be a JSON object', 400);
      }
    } else {
      claims = input.claims ?? {};
    }
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
      throw new HttpException('claims must be a JSON object', 400);
    }
    // `role` inside the claims is what `auth.role()` reads; keep it consistent
    // with the role actually being assumed rather than trusting the caller.
    return { role, claims: JSON.stringify({ ...claims, role }) };
  }

  async simulate(input: SimulateInput): Promise<SimulateResult> {
    const sql = this.assertSingleRead(input.sql);
    const ctx = await this.resolveContext(input);
    const limit = clamp(input.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const timeoutMs = clamp(input.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    // One extra row is fetched purely to detect truncation.
    const wrapped = `SELECT * FROM (${sql}) AS rls_simulation LIMIT ${limit + 1}`;

    const relations = await this.planRelations(wrapped);

    const { rows, denied } = await this.di.RlsPool.withRlsTx(
      ctx,
      async client => {
        try {
          const result = await client.query(wrapped);
          return { rows: result.rows, denied: null as SimulateResult['denied'] };
        } catch (err) {
          if (errorCode(err) === '57014') {
            throw new HttpException(`Query cancelled after ${timeoutMs}ms.`, 400);
          }
          // A missing GRANT is an answer, not a failure: it is the other reason a
          // caller sees nothing, and the one RLS policies cannot explain. Report
          // it alongside the attribution instead of throwing it away as a 400.
          const code = errorCode(err);
          if (code === '42501') {
            return { rows: [], denied: { code, message: errorMessage(err) } };
          }
          throw new HttpException(formatSqlError(err) || 'SQL error', 400);
        }
      },
      { rollback: true, readOnly: true, statementTimeoutMs: timeoutMs }
    );

    const truncated = rows.length > limit;
    const visible = truncated ? rows.slice(0, limit) : rows;

    return {
      role: ctx.role,
      claims: JSON.parse(ctx.claims),
      columns: visible.length ? Object.keys(visible[0]) : [],
      rows: sanitize(visible),
      rowCount: visible.length,
      truncated,
      denied,
      tables: await this.attribute(relations, ctx.role),
    };
  }

  /**
   * The tables the query touches, read from a plan produced on the control
   * plane rather than inside the simulated transaction.
   *
   * That looks like the wrong plane to use, and it is deliberate: when RLS is on
   * and no policy grants the role access, the planner collapses the scan to a
   * one-time false filter and the relation disappears from the plan entirely.
   * Planning under the simulated role would therefore lose exactly the table the
   * caller most needs named. EXPLAIN without ANALYZE does not execute anything,
   * and the statement has already been proved to be a single read.
   */
  private async planRelations(wrapped: string): Promise<string[]> {
    try {
      const plan = await this.di.prisma.$queryRawUnsafe<any[]>(`EXPLAIN (VERBOSE, FORMAT JSON) ${wrapped}`);
      const raw = plan?.[0]?.['QUERY PLAN'];
      const found = new Set<string>();
      relationsInPlan(typeof raw === 'string' ? JSON.parse(raw) : raw, found);
      return Array.from(found).sort();
    } catch {
      // Attribution is a convenience. A plan that cannot be produced must not
      // cost the caller the rows themselves.
      return [];
    }
  }

  /**
   * Policy attribution. `pg_policies` is read on the control plane (the caller's
   * role may not see every catalog row) and cross-checked against the relations
   * the planner actually touched, so a policy on an unrelated table is not
   * reported as if it had decided anything.
   */
  private async attribute(relations: string[], role: RlsRole): Promise<SimulateTable[]> {
    if (!relations.length) return [];

    const parsed = relations.map(name => {
      const dot = name.indexOf('.');
      return { schema: name.slice(0, dot), table: name.slice(dot + 1) };
    });

    // Filtered on each column separately and paired up in JS below: a row
    // comparison against an array of pairs is not something Postgres accepts.
    const schemas = Array.from(new Set(parsed.map(p => p.schema)));
    const tables = Array.from(new Set(parsed.map(p => p.table)));

    const rlsRows = await this.di.prisma.$queryRawUnsafe<Array<{ schema: string; table: string; rls: boolean }>>(
      `SELECT n.nspname AS "schema", c.relname AS "table", c.relrowsecurity AS rls
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1::text[]) AND c.relname = ANY($2::text[])`,
      schemas,
      tables
    );

    const policyRows = await this.di.prisma.$queryRawUnsafe<any[]>(
      `SELECT schemaname AS "schema", tablename AS "table", policyname, cmd, roles, qual, with_check
         FROM pg_policies
        WHERE schemaname = ANY($1::text[]) AND tablename = ANY($2::text[])`,
      schemas,
      tables
    );

    // Privileges are the gate in front of RLS: with no SELECT grant, Postgres
    // raises rather than filtering, and no policy can rescue it.
    const grantRows = await this.di.prisma.$queryRawUnsafe<
      Array<{ schema: string; table: string; privilege: string }>
    >(
      `SELECT table_schema AS "schema", table_name AS "table", privilege_type AS privilege
         FROM information_schema.role_table_grants
        WHERE grantee = $1 AND table_schema = ANY($2::text[]) AND table_name = ANY($3::text[])`,
      role,
      schemas,
      tables
    );

    return parsed.map(({ schema, table }) => {
      const rlsEnabled = Boolean(rlsRows.find(r => r.schema === schema && r.table === table)?.rls);
      const policies: SimulatePolicy[] = policyRows
        .filter(p => p.schema === schema && p.table === table)
        .map(p => {
          const roles: string[] = Array.isArray(p.roles)
            ? p.roles
            : String(p.roles).replace(/[{}]/g, '').split(',').filter(Boolean);
          return {
            name: p.policyname,
            command: p.cmd,
            roles,
            using: p.qual ?? null,
            withCheck: p.with_check ?? null,
            // A read consults SELECT and ALL policies only, and only those
            // granted to this role or to PUBLIC.
            applies:
              (p.cmd === 'SELECT' || p.cmd === 'ALL') &&
              (roles.includes(role) || roles.includes('public') || roles.includes('PUBLIC')),
          };
        });
      const privileges = grantRows
        .filter(g => g.schema === schema && g.table === table)
        .map(g => g.privilege)
        .sort();

      // The two most common "why do I see nothing" causes, named explicitly
      // instead of leaving the caller to infer them from an empty result.
      const deniedBy: SimulateTable['deniedBy'] = !privileges.includes('SELECT')
        ? 'grant'
        : rlsEnabled && !policies.some(p => p.applies)
          ? 'policy'
          : null;

      return { schema, table, rlsEnabled, privileges, deniesAll: deniedBy !== null, deniedBy, policies };
    });
  }

  /**
   * "Why is this row hidden": run the same query as two different callers and
   * report the symmetric difference. Rows are compared on their serialized form,
   * because the query need not select a primary key.
   */
  async diff(
    sql: string,
    left: Omit<SimulateInput, 'sql'>,
    right: Omit<SimulateInput, 'sql'>
  ): Promise<SimulateDiff> {
    const leftResult = await this.simulate({ ...left, sql });
    const rightResult = await this.simulate({ ...right, sql });
    const key = (row: any) => JSON.stringify(row);
    const leftKeys = new Set(leftResult.rows.map(key));
    const rightKeys = new Set(rightResult.rows.map(key));
    return {
      left: leftResult,
      right: rightResult,
      onlyInLeft: leftResult.rows.filter(row => !rightKeys.has(key(row))),
      onlyInRight: rightResult.rows.filter(row => !leftKeys.has(key(row))),
    };
  }
}
