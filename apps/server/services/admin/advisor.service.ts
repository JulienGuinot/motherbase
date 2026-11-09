import BaseContext from '../../context/base-context';
import type { PgPolicy } from './rls.service';
import { indexSuggestionFindings } from './index-advisor.service';

export type AdvisorLevel = 'critical' | 'warning' | 'info';
type AdvisorCategory = 'security' | 'performance' | 'abuse' | 'operations';

export interface AdvisorFinding {
  id: string;
  category: AdvisorCategory;
  level: AdvisorLevel;
  title: string;
  detail: string;
  target: string;
  remediation?: string;
}

export interface AdvisorReport {
  findings: AdvisorFinding[];
  counts: Record<AdvisorLevel, number>;
  ranAt: string;
}

// ── Shapes the pure linters operate on (kept DB-agnostic for testing) ─────────

export interface LintModel {
  model: string;
  dbName?: string;
  system: boolean;
  fields: { name: string }[];
}

/** RLS table state as returned by RlsService.listTables(). */
export interface LintTable {
  table: string;
  rlsEnabled: boolean;
  policies: PgPolicy[];
}

export interface PerfRows {
  tablesWithoutPk: { table: string }[];
  unindexedFks: { table: string; column: string; constraint: string }[];
  unusedIndexes: { table: string; index: string }[];
  bloatedTables: { table: string; deadTuples: number; liveTuples: number }[];
}

/** A table reached from inside a policy expression, and whether the policy leans on it. */
interface LintIndex {
  table: string;
  /** Leading column of the index. A filter on any other column cannot use it. */
  column: string;
}

export interface LintFunction {
  schema: string;
  name: string;
  securityDefiner: boolean;
  /** Roles (or PUBLIC) holding EXECUTE. */
  executableBy: string[];
}

export interface SecurityLintExtras {
  indexes?: LintIndex[];
  functions?: LintFunction[];
}

const SENSITIVE = /pass|secret|token|hash|api[_-]?key|salt|private|credential/i;
const WRITE_COMMANDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'ALL']);

/**
 * Tables a policy expression reads. Postgres normalises quals into a stable
 * printed form, so `FROM x`, `JOIN x` and `FROM public.x alias` are all that has
 * to be recognised. Over-matching is cheap here (the name is looked up in the
 * table map and unknown names are dropped); missing a table is what would hurt.
 */
export function tablesReferencedByPolicy(expr: string | null): string[] {
  if (!expr) return [];
  const found = new Set<string>();
  const re = /\b(?:FROM|JOIN)\s+(?:ONLY\s+)?(?:"?public"?\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) found.add(m[1]);
  return Array.from(found);
}

/**
 * Columns a policy expression filters on. Only the left-hand side of a
 * comparison counts: those are the ones an index could serve.
 */
export function columnsFilteredByPolicy(expr: string | null): string[] {
  if (!expr) return [];
  const found = new Set<string>();
  // `(col = ...)`, `col IN (...)`, `col @> ...` and the quoted forms of each.
  const re = /(?:^|[\s(])"?([a-z_][a-z0-9_]*)"?\s*(?:=|<>|!=|@>|&&|IN\b|LIKE\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) {
    const name = m[1].toLowerCase();
    // Skip SQL keywords that can sit in that position.
    if (['select', 'where', 'and', 'or', 'not', 'true', 'false', 'null', 'case', 'when', 'then'].includes(name)) {
      continue;
    }
    found.add(name);
  }
  return Array.from(found);
}

/**
 * A policy expression is "permissive" when it grants unconditional access: either
 * Postgres treats a missing expression (null) as permissive, or the expression is a
 * literal `true`.
 */
export function isPermissive(expr: string | null): boolean {
  if (expr == null) return true;
  return expr.trim().toLowerCase() === 'true';
}

/** True when an expression references an owner/identity check (auth.uid / auth.jwt). */
function referencesAuth(expr: string | null): boolean {
  if (!expr) return false;
  const e = expr.toLowerCase();
  return e.includes('auth.uid()') || e.includes('auth.jwt()');
}

// ── Pure security linter (RLS-aware) ──────────────────────────────────────────

interface PolicyContext {
  model: LintModel;
  table: LintTable;
  policy: PgPolicy;
  tablesByName: Map<string, LintTable>;
}

export function lintSecurity(
  models: LintModel[],
  tables: LintTable[],
  extras: SecurityLintExtras = {}
): AdvisorFinding[] {
  const tablesByName = new Map(tables.map(t => [t.table, t]));
  const indexedColumns = indexedColumnsByTable(extras.indexes ?? []);
  const findings = lintDefinerFunctions(extras.functions ?? []);

  for (const model of models) {
    if (model.system) continue;
    const table = tablesByName.get(model.dbName ?? model.model) ?? tablesByName.get(model.model);
    if (!table) continue;

    const tableFinding = lintTableRls(model, table);
    if (tableFinding) {
      findings.push(tableFinding);
      continue;
    }

    for (const policy of table.policies) {
      const ctx = { model, table, policy, tablesByName };
      findings.push(
        ...lintPolicyJoins(ctx),
        ...lintUnindexedPolicyColumns(ctx, indexedColumns.get(table.table)),
        ...lintAnonAccess(ctx),
        ...lintUnscopedAuthenticatedWrite(ctx),
      );
    }
  }

  return findings;
}

function indexedColumnsByTable(indexes: LintIndex[]): Map<string, Set<string>> {
  const indexed = new Map<string, Set<string>>();
  for (const index of indexes) {
    const columns = indexed.get(index.table) ?? new Set<string>();
    columns.add(index.column.toLowerCase());
    indexed.set(index.table, columns);
  }
  return indexed;
}

/** A table with RLS off, or on without a policy, has nothing per-policy left to lint. */
function lintTableRls(model: LintModel, table: LintTable): AdvisorFinding | null {
  // RLS disabled → /rest/v1 refuses the table (withRls requires relrowsecurity),
  // but nothing else does: a function called through rpc() runs as the caller
  // and the broad data-plane grants alone decide, every row.
  if (!table.rlsEnabled) {
    return {
      id: 'sec_rls_disabled',
      category: 'security',
      level: 'critical',
      title: 'Table has row level security off',
      detail: `Row level security is OFF on "${model.model}". The REST API refuses the table (403), but any function callers reach through rpc() that reads or writes it does so on every row, for anon and authenticated alike.`,
      target: model.model,
      remediation: 'Enable RLS on the table and add explicit PostgreSQL policies, for example owner access with auth.uid() = user_id or admin access with auth.jwt().',
    };
  }
  if (table.policies.length === 0) {
    return {
      id: 'sec_no_policy',
      category: 'security',
      level: 'info',
      title: 'Table has RLS on with no policy',
      detail: `"${model.model}" has RLS enabled but no policy, so it is fully blocked for non-admins. Add a policy if it should be reachable.`,
      target: model.model,
    };
  }
  return null;
}

/**
 * A policy that reaches into another table inherits that table's exposure: if
 * the joined table has RLS off, whoever can write there decides who can read here.
 */
function lintPolicyJoins({ model, table, policy, tablesByName }: PolicyContext): AdvisorFinding[] {
  const findings: AdvisorFinding[] = [];
  for (const expr of [policy.using, policy.withCheck]) {
    for (const name of tablesReferencedByPolicy(expr)) {
      if (name === table.table) continue;
      const joined = tablesByName.get(name);
      if (!joined || joined.rlsEnabled) continue;
      findings.push({
        id: 'sec_policy_joins_unprotected',
        category: 'security',
        level: 'critical',
        title: 'Policy depends on an unprotected table',
        detail: `Policy "${policy.name}" on "${model.model}" decides access by reading "${name}", which has RLS disabled. Anyone able to write to "${name}" can grant themselves access to "${model.model}".`,
        target: `${model.model}.${policy.name}`,
        remediation: `Enable RLS on "${name}" and give it its own policies, or move the check into a SECURITY DEFINER function with a fixed search_path.`,
      });
    }
  }
  return findings;
}

/**
 * A policy runs per row on every query against the table, so a filter on an
 * unindexed column turns each of those into a scan. Without index data for the
 * table nothing is reported.
 */
function lintUnindexedPolicyColumns(
  { model, table, policy }: PolicyContext,
  indexed: Set<string> | undefined
): AdvisorFinding[] {
  if (!indexed) return [];
  // The extractor is a regex and picks up function arguments and literals too,
  // so only columns the table actually has are kept.
  const tableColumns = new Set(model.fields.map(f => f.name.toLowerCase()));
  return columnsFilteredByPolicy(policy.using)
    .filter(column => !indexed.has(column) && tableColumns.has(column))
    .map(column => ({
      id: 'perf_policy_unindexed_column',
      category: 'performance',
      level: 'warning',
      title: 'Policy filters on an unindexed column',
      detail: `Policy "${policy.name}" filters "${model.model}" on "${column}", which has no index. The policy is evaluated for every candidate row, so this cost is paid by every query on the table.`,
      target: `${model.model}.${column}`,
      remediation: `CREATE INDEX "idx_${table.table}_${column}" ON "${table.table}" ("${column}");`,
    }));
}

function lintAnonAccess({ model, policy }: PolicyContext): AdvisorFinding[] {
  if (!policy.roles.includes('anon')) return [];
  const findings: AdvisorFinding[] = [];
  const cmd = policy.command;
  const target = `${model.model}.${policy.name}`;

  if ((cmd === 'SELECT' || cmd === 'ALL') && isPermissive(policy.using)) {
    const sensitiveFields = model.fields.filter(f => SENSITIVE.test(f.name)).map(f => f.name);
    findings.push(sensitiveFields.length
      ? {
          id: 'sec_anon_read_sensitive',
          category: 'security',
          level: 'critical',
          title: 'Sensitive columns publicly readable',
          detail: `Policy "${policy.name}" lets anyone (anon) read "${model.model}", exposing sensitive column(s): ${sensitiveFields.join(', ')}.`,
          target,
          remediation: 'Restrict the policy or drop/mask the sensitive columns from this table.',
        }
      : {
          id: 'sec_anon_read_open',
          category: 'security',
          level: 'warning',
          title: 'Public read access',
          detail: `Policy "${policy.name}" lets anyone read this table over REST. This is fine only for deliberately public data.`,
          target,
          remediation: 'Scope the USING expression to authenticated callers or row owners unless this table is intentionally public.',
        });
  }

  if (WRITE_COMMANDS.has(cmd) && (isPermissive(policy.using) || isPermissive(policy.withCheck))) {
    findings.push({
      id: 'sec_anon_write',
      category: 'security',
      level: 'critical',
      title: 'Unauthenticated writes allowed',
      detail: `Policy "${policy.name}" lets anyone (anon) ${cmd} on "${model.model}". Unauthenticated writes are almost never intended.`,
      target,
      remediation: 'Restrict the policy to authenticated callers, row owners, or admins.',
    });
  }

  return findings;
}

function lintUnscopedAuthenticatedWrite({ model, policy }: PolicyContext): AdvisorFinding[] {
  const cmd = policy.command;
  if (!policy.roles.includes('authenticated') || !WRITE_COMMANDS.has(cmd)) return [];

  const relevant = cmd === 'INSERT' ? policy.withCheck : (policy.using ?? policy.withCheck);
  const rowScoped = !isPermissive(relevant) || referencesAuth(policy.using) || referencesAuth(policy.withCheck);
  if (rowScoped) return [];

  return [{
    id: 'sec_auth_write_unscoped',
    category: 'security',
    level: 'warning',
    title: 'Authenticated write is not row-scoped',
    detail: `Policy "${policy.name}" lets any signed-in user ${cmd} any row on "${model.model}" (not row-scoped to an owner).`,
    target: `${model.model}.${policy.name}`,
    remediation: 'Add an owner condition such as auth.uid() = user_id, or restrict to admins.',
  }];
}

/**
 * A SECURITY DEFINER function runs with its owner's privileges and bypasses RLS
 * on everything it touches. One that anon can execute is a hole straight through
 * every policy in the database, so it is reported whatever the body looks like.
 */
export function lintDefinerFunctions(functions: LintFunction[]): AdvisorFinding[] {
  const findings: AdvisorFinding[] = [];
  for (const fn of functions) {
    if (!fn.securityDefiner) continue;
    const anonCallable = fn.executableBy.some(r => r === 'anon' || r === 'PUBLIC' || r === 'public');
    if (!anonCallable) continue;
    findings.push({
      id: 'sec_definer_callable_by_anon',
      category: 'security',
      level: 'critical',
      title: 'SECURITY DEFINER function callable by anon',
      detail: `"${fn.schema}.${fn.name}" runs as its owner and so ignores row level security, and anon can execute it. Whatever it reads or writes is reachable without authentication.`,
      target: `${fn.schema}.${fn.name}`,
      remediation: `REVOKE EXECUTE ON FUNCTION ${fn.schema}.${fn.name} FROM PUBLIC, anon; or rewrite it as SECURITY INVOKER.`,
    });
  }
  return findings;
}

// ── Pure performance linter ───────────────────────────────────────────────────

export function lintPerformance(rows: PerfRows): AdvisorFinding[] {
  const findings: AdvisorFinding[] = [];

  for (const r of rows.tablesWithoutPk) {
    findings.push({
      id: 'perf_no_pk',
      category: 'performance',
      level: 'warning',
      title: 'Table without primary key',
      detail: `"${r.table}" has no primary key. Replication, dedup and row identity all suffer.`,
      target: r.table,
      remediation: `ALTER TABLE "${r.table}" ADD COLUMN id uuid PRIMARY KEY DEFAULT gen_random_uuid();`,
    });
  }

  for (const r of rows.unindexedFks) {
    findings.push({
      id: 'perf_unindexed_fk',
      category: 'performance',
      level: 'warning',
      title: 'Foreign key without index',
      detail: `"${r.table}.${r.column}" is a foreign key with no covering index. Joins and cascade deletes will seq-scan.`,
      target: `${r.table}.${r.column}`,
      remediation: `CREATE INDEX "idx_${r.table}_${r.column}" ON "${r.table}" ("${r.column}");`,
    });
  }

  for (const r of rows.unusedIndexes) {
    findings.push({
      id: 'perf_unused_index',
      category: 'performance',
      level: 'info',
      title: 'Unused index',
      detail: `Index "${r.index}" on "${r.table}" has never been scanned. It costs write throughput and disk for no read benefit.`,
      target: r.index,
      remediation: `DROP INDEX "${r.index}";`,
    });
  }

  for (const r of rows.bloatedTables) {
    findings.push({
      id: 'perf_bloat',
      category: 'performance',
      level: 'info',
      title: 'Table needs vacuum',
      detail: `"${r.table}" has ${r.deadTuples} dead tuples vs ${r.liveTuples} live. Autovacuum may be falling behind.`,
      target: r.table,
      remediation: `VACUUM ANALYZE "${r.table}";`,
    });
  }

  return findings;
}

const JOB_ALERT_TITLES = {
  consecutive_failures: 'Scheduled job is failing repeatedly',
  missed_window: 'Scheduled job stopped running',
  dead_letter_depth: 'Realtime events are undeliverable',
  backup_older_than_rpo: 'Newest backup is older than the objective',
};

const JOB_ALERT_REMEDIATION = {
  consecutive_failures: 'Read the error on GET /api/admin/jobs/runs?job=<job> and fix the cause; the job keeps retrying on its schedule.',
  missed_window: 'Check that the schedule is enabled and that the process running it is up.',
  dead_letter_depth: 'Inspect the failed rows in RealtimeOutbox. They have exhausted their retries and will not be delivered.',
  backup_older_than_rpo: 'Run a backup now and check the schedule; the last successful one is outside the recovery objective.',
};

// ── Service: gathers live data then runs the pure linters ─────────────────────

export class AdvisorService extends BaseContext {
  async run(): Promise<AdvisorReport> {
    const [models, tables, perf, extras, jobAlerts, indexSuggestions] = await Promise.all([
      this.di.RestApiService.listModels(),
      this.di.RlsService.listTables(),
      this.loadPerf(),
      this.loadSecurityExtras(),
      this.loadJobAlerts(),
      // Empty unless index_advisor and pg_stat_statements are both on; never throws.
      this.di.IndexAdvisorService.suggestForSlowQueries(),
    ]);

    const findings = [
      ...lintSecurity(models as LintModel[], tables as LintTable[], extras),
      ...lintPerformance(perf),
      ...indexSuggestionFindings(indexSuggestions),
      ...jobAlerts,
    ];

    const counts: Record<AdvisorLevel, number> = { critical: 0, warning: 0, info: 0 };
    for (const f of findings) counts[f.level]++;

    return { findings, counts, ranAt: new Date().toISOString() };
  }

  /**
   * Scheduler health, folded into the advisor rather than given its own surface.
   * A silently dead backup job belongs in the same list an operator already
   * checks, not behind a second one they have to remember exists.
   */
  private async loadJobAlerts(): Promise<AdvisorFinding[]> {
    try {
      const alerts = await this.di.JobLedgerService.announce();
      return alerts.map((alert: any) => ({
        id: `ops_${alert.kind}`,
        category: 'operations' as const,
        level: alert.level as AdvisorLevel,
        title: JOB_ALERT_TITLES[alert.kind as keyof typeof JOB_ALERT_TITLES] ?? 'Scheduled job problem',
        detail: alert.message,
        target: alert.job,
        remediation: JOB_ALERT_REMEDIATION[alert.kind as keyof typeof JOB_ALERT_REMEDIATION],
      }));
    } catch {
      // The advisor is a report. A ledger that is unavailable (not migrated yet,
      // for instance) must not take the security findings down with it.
      return [];
    }
  }

  private async loadSecurityExtras(): Promise<SecurityLintExtras> {
    const prisma = this.di.prisma;

    // Leading index column only: an index on (b, a) does not help a filter on a.
    const indexes = await prisma.$queryRawUnsafe<LintIndex[]>(`
      SELECT t.relname AS "table", a.attname AS "column"
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
      WHERE n.nspname = 'public'
    `);

    const functions = await prisma.$queryRawUnsafe<
      Array<{ schema: string; name: string; securitydefiner: boolean; executableby: string[] }>
    >(`
      SELECT n.nspname AS "schema",
             p.proname AS "name",
             p.prosecdef AS "securitydefiner",
             COALESCE(
               ARRAY(
                 SELECT grantee FROM (
                   SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
                          acl.privilege_type
                   FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
                 ) g
                 WHERE g.privilege_type = 'EXECUTE'
               ),
               '{}'
             ) AS "executableby"
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prosecdef
        -- A trigger function cannot be invoked directly (no arguments, trigger
        -- return type), so an EXECUTE grant on one is not a callable entry point.
        AND p.prorettype <> 'trigger'::regtype
    `);

    return {
      indexes,
      functions: functions.map(f => ({
        schema: f.schema,
        name: f.name,
        securityDefiner: Boolean(f.securitydefiner),
        executableBy: f.executableby ?? [],
      })),
    };
  }

  private async loadPerf(): Promise<PerfRows> {
    const prisma = this.di.prisma;

    const tablesWithoutPk = await prisma.$queryRawUnsafe<{ table: string }[]>(`
      SELECT t.relname AS table
      FROM pg_class t
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relkind = 'r'
        AND t.relname NOT LIKE '\\_prisma\\_%'
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint c WHERE c.conrelid = t.oid AND c.contype = 'p'
        )
      ORDER BY t.relname
    `);

    const unindexedFks = await prisma.$queryRawUnsafe<{ table: string; column: string; constraint: string }[]>(`
      SELECT t.relname AS table, a.attname AS column, c.conname AS constraint
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f'
        AND n.nspname = 'public'
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.conrelid AND i.indkey[0] = a.attnum
        )
      ORDER BY t.relname, a.attname
    `);

    const unusedIndexes = await prisma.$queryRawUnsafe<{ table: string; index: string }[]>(`
      SELECT ui.relname AS table, ui.indexrelname AS index
      FROM pg_stat_user_indexes ui
      JOIN pg_index i ON i.indexrelid = ui.indexrelid
      WHERE ui.schemaname = 'public'
        AND ui.idx_scan = 0
        AND NOT i.indisunique
        AND NOT i.indisprimary
      ORDER BY ui.relname, ui.indexrelname
    `);

    const bloatedRaw = await prisma.$queryRawUnsafe<{ table: string; deadtuples: bigint; livetuples: bigint }[]>(`
      SELECT relname AS table, n_dead_tup AS deadtuples, n_live_tup AS livetuples
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
        AND n_dead_tup > 1000
        AND n_dead_tup > n_live_tup * 0.1
      ORDER BY n_dead_tup DESC
    `);

    return {
      tablesWithoutPk,
      unindexedFks,
      unusedIndexes,
      bloatedTables: bloatedRaw.map(r => ({
        table: r.table,
        deadTuples: Number(r.deadtuples),
        liveTuples: Number(r.livetuples),
      })),
    };
  }
}
