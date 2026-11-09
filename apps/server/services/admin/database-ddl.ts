import { HttpException } from '../../exceptions/http-exception';
import { formatSqlError } from '../../lib/pg-error';
import { quoteIdentCatalog } from '../../lib/sql-identifier';
import { quoteIdent } from './schema-ddl';

/**
 * Pure SQL builders for the Database section (roles, column privileges,
 * publications). No I/O here: every branch that decides what statement runs is
 * a function of its input, so it is unit-tested without a database.
 */

/**
 * A string literal, quoted the way Postgres' own `quote_literal` does it.
 *
 * Role passwords, `VALID UNTIL` timestamps and configuration values end up in
 * DDL, which cannot take bind parameters. Doubling the quote is the whole
 * escape under `standard_conforming_strings` (the default since 9.1); a value
 * with a backslash additionally gets the `E''` form so the literal means the
 * same thing whatever that setting is.
 */
export function quoteLiteral(value: string): string {
  const quoted = value.replace(/'/g, "''");
  return value.includes('\\') ? `E'${quoted.replace(/\\/g, '\\\\')}'` : `'${quoted}'`;
}

/**
 * Surface Postgres' own sentence for a failed admin statement.
 *
 * Without this a `DROP ROLE` blocked by owned objects, or a publication that
 * names a missing table, reaches the console as a masked 500 in production.
 * Those are operator mistakes with a precise fix, and the message says it.
 */
export async function explainPgFailure<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    if (error instanceof HttpException) throw error;
    throw new HttpException(formatSqlError(error) || 'Statement failed', 400);
  }
}

// ── Roles ────────────────────────────────────────────────────────────────────

/**
 * Roles this platform or Postgres itself depends on. The server connects as
 * `postgres`; REST switches to `anon` / `authenticated` / `service_role` on
 * every request, and the RLS presets grant to them by name. Renaming or
 * dropping one breaks every request, and turning off LOGIN on `postgres` locks
 * the server out of its own database. `supabase_*` and friends arrive with an
 * imported Supabase dump and are owned by objects it created.
 */
const RESERVED_ROLES = new Set([
  'postgres',
  'anon',
  'authenticated',
  'service_role',
  'authenticator',
  'dashboard_user',
  'pgbouncer',
]);

/** Why a role cannot be changed from the console, or null when it can. */
export function reservedRoleReason(name: string, currentUser: string): string | null {
  if (name === currentUser) return 'The server connects to the database as this role.';
  if (name.startsWith('pg_')) return 'Predefined Postgres role.';
  if (name.startsWith('supabase_')) return 'Supabase system role.';
  if (RESERVED_ROLES.has(name)) return 'Motherbase relies on this role for API access.';
  return null;
}

export interface RoleAttributes {
  canLogin?: boolean;
  isSuperuser?: boolean;
  canCreateDb?: boolean;
  canCreateRole?: boolean;
  canReplicate?: boolean;
  canBypassRls?: boolean;
  inheritRole?: boolean;
  /** -1 for unlimited, the Postgres convention. */
  connectionLimit?: number;
  /** A new password, or null to remove it. Absent leaves it unchanged. */
  password?: string | null;
  /** ISO timestamp, or null for "never expires". */
  validUntil?: string | null;
}

const ROLE_FLAGS: Array<[keyof RoleAttributes, string]> = [
  ['canLogin', 'LOGIN'],
  ['isSuperuser', 'SUPERUSER'],
  ['canCreateDb', 'CREATEDB'],
  ['canCreateRole', 'CREATEROLE'],
  ['canReplicate', 'REPLICATION'],
  ['canBypassRls', 'BYPASSRLS'],
  ['inheritRole', 'INHERIT'],
];

/**
 * The option list shared by CREATE ROLE and ALTER ROLE. Only the attributes
 * present in the input are emitted, so an ALTER changes exactly what the
 * operator touched and leaves the rest as Postgres has it.
 */
export function roleOptionsSql(attributes: RoleAttributes): string {
  const options: string[] = [];
  for (const [key, keyword] of ROLE_FLAGS) {
    const value = attributes[key];
    if (value !== undefined) options.push(value ? keyword : `NO${keyword}`);
  }
  if (attributes.connectionLimit !== undefined) {
    options.push(`CONNECTION LIMIT ${Math.trunc(attributes.connectionLimit)}`);
  }
  if (attributes.password !== undefined) {
    options.push(attributes.password === null ? 'PASSWORD NULL' : `PASSWORD ${quoteLiteral(attributes.password)}`);
  }
  if (attributes.validUntil !== undefined) {
    options.push(`VALID UNTIL ${quoteLiteral(attributes.validUntil ?? 'infinity')}`);
  }
  return options.join(' ');
}

// ── Column privileges ────────────────────────────────────────────────────────

export const COLUMN_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] as const;
export type ColumnPrivilege = (typeof COLUMN_PRIVILEGES)[number];

export interface ColumnPrivilegeChange {
  /** Schema-qualified, already quoted table reference. */
  table: string;
  role: string;
  privilege: ColumnPrivilege;
  /** The columns being granted or revoked. */
  columns: string[];
  grant: boolean;
  /** Every column of the table, in order. */
  allColumns: string[];
  /** True when the role holds `privilege` on the whole table. */
  tableLevel: boolean;
}

/**
 * The statements that make `columns` granted or revoked, and nothing else.
 *
 * A column GRANT is additive and always simple. A column REVOKE is not, when
 * the role holds the privilege at table level: Postgres keeps table and column
 * ACLs separately, and revoking a column leaves the table grant, so the column
 * stays readable. Supabase's Column Privileges screen solves this the only way
 * Postgres allows, and so does this: drop the table-level grant, then grant the
 * columns that should keep the privilege one by one. Run as one transaction,
 * the role never sees an intermediate state.
 */
export function columnPrivilegeStatements(change: ColumnPrivilegeChange): string[] {
  const role = quoteIdent(change.role);
  const list = (columns: string[]) => columns.map(quoteIdent).join(', ');
  if (!change.columns.length) return [];

  if (change.grant) {
    // Already covered by the table-level grant: a column grant would add a
    // redundant ACL entry that outlives a later table-level revoke.
    if (change.tableLevel) return [];
    return [`GRANT ${change.privilege} (${list(change.columns)}) ON TABLE ${change.table} TO ${role}`];
  }

  const statements: string[] = [];
  if (change.tableLevel) {
    const revoked = new Set(change.columns);
    const kept = change.allColumns.filter(column => !revoked.has(column));
    statements.push(`REVOKE ${change.privilege} ON TABLE ${change.table} FROM ${role}`);
    if (kept.length) statements.push(`GRANT ${change.privilege} (${list(kept)}) ON TABLE ${change.table} TO ${role}`);
  }
  statements.push(`REVOKE ${change.privilege} (${list(change.columns)}) ON TABLE ${change.table} FROM ${role}`);
  return statements;
}

// ── Publications ─────────────────────────────────────────────────────────────

export interface PublishActions {
  insert: boolean;
  update: boolean;
  delete: boolean;
  truncate: boolean;
}

export const PUBLISH_ACTIONS = ['insert', 'update', 'delete', 'truncate'] as const;

/** `publish = '...'`. At least one action, or the publication streams nothing. */
export function publishOptionSql(actions: PublishActions): string {
  const enabled = PUBLISH_ACTIONS.filter(action => actions[action]);
  if (!enabled.length) {
    throw new HttpException('A publication must publish at least one of insert, update, delete or truncate', 400);
  }
  return `publish = ${quoteLiteral(enabled.join(', '))}`;
}

// ── Postgres configuration ───────────────────────────────────────────────────

/**
 * Where a setting override lives. `database` and `role` are `ALTER DATABASE /
 * ROLE ... SET`, stored in the catalog and applied to new sessions; `system` is
 * `ALTER SYSTEM`, written to `postgresql.auto.conf` in the data directory,
 * which is what Supabase's `postgres-config update` changes.
 */
export const CONFIG_SCOPES = ['database', 'role', 'system'] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];

/**
 * The scopes Postgres accepts for a setting, from `pg_settings.context`.
 * Session-settable ones (`user`, `superuser`) may be pinned per database or per
 * role; `sighup` and `postmaster` ones are server-wide by definition.
 */
export function settingScopes(context: string): ConfigScope[] {
  return context === 'user' || context === 'superuser' ? ['database', 'role', 'system'] : ['system'];
}

/** The narrowest scope a setting allows: a per-database override touches the least. */
export function defaultScope(context: string): ConfigScope {
  return settingScopes(context)[0];
}

export interface ConfigTarget {
  scope: ConfigScope;
  /** Setting name, already checked against the curated list. */
  name: string;
  /** `current_database()`, read back from the catalog. */
  database: string;
  role?: string;
}

/**
 * `ALTER ... SET name = 'value'`, or `... RESET name` when `value` is null.
 *
 * The value is always a quoted literal, never spliced: Postgres parses and
 * range-checks it against the setting's type and unit either way (`'64MB'`,
 * `'30s'`, `'on'`), and a literal cannot carry a second statement.
 */
export function configStatement(target: ConfigTarget, value: string | null): string {
  const assignment = value === null ? `RESET ${target.name}` : `SET ${target.name} = ${quoteLiteral(value)}`;
  switch (target.scope) {
    case 'system':
      return `ALTER SYSTEM ${assignment}`;
    case 'database':
      return `ALTER DATABASE ${quoteIdentCatalog(target.database)} ${assignment}`;
    case 'role':
      if (!target.role) throw new HttpException('role is required for a role-level setting', 400);
      return `ALTER ROLE ${quoteIdent(target.role)} IN DATABASE ${quoteIdentCatalog(target.database)} ${assignment}`;
  }
}
