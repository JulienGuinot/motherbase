import type { ToolSpec } from '../types';

/** Caps a list result so one tool call cannot flood the context window. */
function capRows(max: number) {
  return (result: unknown) => {
    if (Array.isArray(result)) {
      return result.length > max ? { truncated: true, shown: max, rows: result.slice(0, max) } : result;
    }
    const rows = (result as { rows?: unknown[] })?.rows;
    if (Array.isArray(rows) && rows.length > max) {
      return { ...(result as object), truncated: true, shown: max, rows: rows.slice(0, max) };
    }
    return result;
  };
}

const schemaArg = {
  type: 'object',
  properties: { schema: { type: 'string', description: 'Postgres schema. Defaults to public.' } },
} as const;

const WRITE_KEYWORD =
  /\b(insert|update|delete|drop|create|alter|truncate|grant|revoke|comment|copy|call|do|vacuum|reindex|refresh|set|reset|begin|commit|rollback|merge|import|security\s+label)\b/i;
const READ_START = /^(select|with|explain|show|table|values)\b/i;

// Statement-keyword blocklists cannot catch a mutation performed through an
// ordinary-looking function call inside a SELECT list: none of these names
// are SQL keywords, so WRITE_KEYWORD never sees them, and Postgres' READ ONLY
// transaction (the hard backstop the /sql/readonly endpoint wraps around
// every read_select call) does not cover them either, because they don't
// write rows through the transaction: they signal another backend, touch the
// filesystem, or open a second connection out from under the transaction.
// Entries are regex fragments. Matched on a function-call boundary (name immediately followed by `(`,
// ignoring whitespace) so it does not fire on an identifier that merely
// contains one of these words.
const DENIED_FUNCTIONS = [
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_read_binary_file',
  'pg_read_file',
  'pg_ls_(?:dir|logdir)', // not pg_ls_waldir: the CLI's db-stats reads the WAL size with it
  'pg_stat_file',
  'pg_sleep',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'pg_file_write',
  'pg_file_unlink',
  'pg_file_rename',
  'lo_\\w+', // large objects: lo_import, lo_export, lo_get, lo_put, ...
  'dblink\\w*', // dblink, dblink_exec, dblink_connect, ...
  'pg_(?:try_)?advisory\\w*', // session locks outlive the READ ONLY transaction
  'set_config',
];
// Quoted function names and comments between the name and `(` are valid SQL.
// Keep the check shared with the server's read-only endpoint: the client-side
// tool guard alone cannot protect callers that invoke that endpoint directly.
const DENIED_FUNCTION_CALL = new RegExp(
  `\\b(?:${DENIED_FUNCTIONS.join('|')})\\b(?:\\s|"|/\\*[\\s\\S]*?\\*/|--[^\\n]*\\n)*\\(`,
  'i',
);

export function hasUnsafeReadFunction(sql: string): boolean {
  return DENIED_FUNCTION_CALL.test(sql);
}

/** Blank out string literals and quoted identifiers, so a value or column named like a keyword is not read as one. */
function withoutQuoted(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}

/**
 * A read tool must not be a write in disguise. Deliberately strict: one
 * statement, starting with a read keyword, containing no write keyword
 * anywhere (which also rules out `WITH t AS (DELETE ...)`), no statement
 * separator, and no call to a function whose side effects escape the
 * read-only transaction. Anything the model needs beyond that is a write
 * tool.
 */
export function isReadOnlySql(sql: string): boolean {
  const trimmed = String(sql ?? '')
    .trim()
    .replace(/;\s*$/, '');
  if (!trimmed) return false;
  if (trimmed.includes(';')) return false;
  if (!READ_START.test(trimmed)) return false;
  if (WRITE_KEYWORD.test(withoutQuoted(trimmed))) return false;
  return !hasUnsafeReadFunction(trimmed);
}

export const READ_TOOLS: ToolSpec[] = [
  {
    name: 'list_schemas',
    description: 'List the Postgres schemas in this project, including the platform schemas.',
    input: { type: 'object', properties: {} },
    mode: 'read',
    http: { method: 'GET', path: '/schema/schemas' },
  },
  {
    name: 'list_tables',
    description:
      'List the tables of a schema, each with its full column list (name, type, nullable, default, isPrimaryKey). ' +
      'This already answers "what does table X look like", so there is no separate describe-table call: read the ' +
      'columns for the table you need out of this result. Start here when you need to know what exists in the database.',
    input: schemaArg as never,
    mode: 'read',
    http: { method: 'GET', path: '/schema/tables' },
    summarize: capRows(200),
  },
  {
    name: 'list_indexes',
    description: 'List the indexes defined on a table. Use when diagnosing a slow query.',
    input: {
      type: 'object',
      properties: { table: { type: 'string' }, schema: { type: 'string' } },
      required: ['table'],
    },
    mode: 'read',
    http: { method: 'GET', path: '/schema/tables/{table}/indexes' },
  },
  {
    name: 'list_schema_indexes',
    description:
      'List every index in a schema with its table, access method, key columns, uniqueness and size. ' +
      'Use to spot a missing or duplicate index across tables; list_indexes covers a single table.',
    input: schemaArg as never,
    mode: 'read',
    http: { method: 'GET', path: '/schema/indexes' },
    summarize: capRows(200),
  },
  {
    name: 'list_enum_types',
    description:
      'List the enumerated types of a schema with their values in order and the columns using them. ' +
      'Read before proposing a column of an enum type or a CHECK that duplicates one.',
    input: schemaArg as never,
    mode: 'read',
    http: { method: 'GET', path: '/schema/enums' },
    summarize: capRows(100),
  },
  {
    name: 'list_roles',
    description:
      'List Postgres roles with login, superuser, bypassrls, connection limit and live connections. ' +
      'Roles with a non-null "reserved" are platform roles the console will not change.',
    input: { type: 'object', properties: {} },
    mode: 'read',
    http: { method: 'GET', path: '/database/roles' },
  },
  {
    name: 'list_column_privileges',
    description: 'For one table, which columns each role (anon, authenticated, ...) may SELECT, INSERT, UPDATE or REFERENCE.',
    input: {
      type: 'object',
      properties: { table: { type: 'string' }, schema: { type: 'string' } },
      required: ['table'],
    },
    mode: 'read',
    http: { method: 'GET', path: '/database/column-privileges' },
  },
  {
    name: 'list_publications',
    description:
      'List logical-replication publications and the tables they include. Motherbase Realtime does not use ' +
      'publications: which tables broadcast is set under Realtime settings.',
    input: { type: 'object', properties: {} },
    mode: 'read',
    http: { method: 'GET', path: '/database/publications' },
  },
  {
    name: 'get_postgres_config',
    description:
      'Read the managed Postgres settings (statement_timeout, work_mem, max_connections, ...) with their current ' +
      'values and overrides. Use when diagnosing timeouts, memory-heavy sorts or connection exhaustion.',
    input: { type: 'object', properties: {} },
    mode: 'read',
    http: { method: 'GET', path: '/database/config' },
  },
  {
    name: 'list_functions',
    description: 'List the Postgres functions declared in a schema.',
    input: schemaArg as never,
    mode: 'read',
    http: { method: 'GET', path: '/schema/functions' },
    summarize: capRows(100),
  },
  {
    name: 'list_triggers',
    description: 'List the triggers declared in a schema.',
    input: schemaArg as never,
    mode: 'read',
    http: { method: 'GET', path: '/schema/triggers' },
    summarize: capRows(100),
  },
  {
    name: 'list_extensions',
    description: 'List the installed Postgres extensions and which ones are available.',
    input: { type: 'object', properties: {} },
    mode: 'read',
    http: { method: 'GET', path: '/schema/extensions' },
    summarize: capRows(100),
  },
  {
    name: 'run_select',
    description:
      'Run one read-only SQL statement and return its rows. Rejected if the statement writes. Use for counts, samples and EXPLAIN.',
    input: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'A single read-only statement.' } },
      required: ['sql'],
    },
    mode: 'read',
    // Hits the dedicated read-only endpoint: the server hardcodes readonly: true
    // there and wraps execution in a real Postgres READ ONLY transaction, so a
    // write is refused by the database itself even if it slips past isReadOnlySql
    // below. That transaction guarantee does not cover side-effecting function
    // calls (killing a backend, exporting a large object to disk, opening a
    // second connection through dblink), which is why isReadOnlySql also denies
    // those by name as a fast pre-check.
    http: { method: 'POST', path: '/sql/readonly' },
    summarize: capRows(50),
    validate: input =>
      isReadOnlySql(String(input.sql ?? ''))
        ? null
        : 'run_select only accepts a single read-only statement. Propose a write action instead.',
  },
  {
    name: 'rls_status',
    description:
      'Report, for every table, whether row level security is enabled and its full list of policies. ' +
      'This already answers "what policies does table X have", so there is no separate list-policies call: ' +
      'read the policies for the table you need out of this result.',
    input: schemaArg as never,
    mode: 'read',
    http: { method: 'GET', path: '/rls/tables' },
    summarize: capRows(200),
  },
  {
    name: 'security_advisor',
    description:
      'Run the built-in security and performance advisor and return its findings. Use when asked "is my project safe" or "what should I fix".',
    input: { type: 'object', properties: {} },
    mode: 'read',
    http: { method: 'GET', path: '/advisor' },
  },
  {
    name: 'read_logs',
    description:
      'Read recent request and error logs. Use to explain an error the user is seeing.',
    input: {
      type: 'object',
      properties: {
        level: { type: 'string', description: 'Filter by level, for example error.' },
        limit: { type: 'number', description: 'How many entries. Defaults to 50.' },
      },
    },
    mode: 'read',
    http: { method: 'GET', path: '/logs' },
    summarize: capRows(50),
  },
  {
    name: 'read_metrics',
    description: 'Read aggregated request metrics for the project (volume, status codes, latency).',
    input: { type: 'object', properties: {} },
    mode: 'read',
    http: { method: 'GET', path: '/metrics/requests' },
  },
  {
    name: 'read_performance',
    description: 'Read the slowest statements recorded for this database.',
    input: { type: 'object', properties: {} },
    mode: 'read',
    http: { method: 'GET', path: '/performance' },
    summarize: capRows(25),
  },
  {
    name: 'advise_indexes',
    description:
      'Suggest indexes for one statement: the CREATE INDEX statements and the estimated cost drop. The statement is only ' +
      'planned over hypothetical indexes, never run. Use after read_performance points at a slow statement.',
    input: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The statement to advise on.' } },
      required: ['query'],
    },
    mode: 'read',
    http: { method: 'POST', path: '/performance/index-advisor' },
  },
  {
    name: 'list_queues',
    description: 'List the message queues (pgmq) with their depth and type. Empty when queues are not enabled.',
    input: { type: 'object', properties: {} },
    mode: 'read',
    http: { method: 'GET', path: '/queues' },
    summarize: capRows(100),
  },
];

/**
 * A write tool must not be a read in disguise: it exists specifically so
 * runAgent's write gate (mode: 'write') sees it and proposes it to the
 * operator instead of running it straight away. Unlike run_select there is no
 * SQL string to police here: each write tool maps to one narrow admin
 * endpoint that already validates its own input server-side.
 */
export const WRITE_TOOLS: ToolSpec[] = [
  {
    name: 'create_table',
    description:
      'Create a table from a single CREATE TABLE statement, optionally applying an RLS policy preset to it in the ' +
      'same transaction. Always proposed to the operator for approval before it runs. Use policyPreset "owner" for ' +
      'a table with a user_id/owner column so only the owning row is readable/writable, "public-read" for data ' +
      'anyone may read but only admins write, or omit it to leave RLS off.',
    input: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single CREATE TABLE statement.' },
        policyPreset: {
          type: 'string',
          description: 'One of: owner, public-read, admin-only. Omit for no policy.',
        },
      },
      required: ['sql'],
    },
    mode: 'write',
    http: { method: 'POST', path: '/schema/tables' },
  },
  {
    name: 'create_index',
    description:
      'Create an index on one or more columns of a table. Always proposed to the operator for approval before it ' +
      'runs. Use after read_performance or run_select EXPLAIN shows a sequential scan on a filtered column.',
    input: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        columns: { type: 'array', items: { type: 'string' } },
        unique: { type: 'boolean' },
        method: { type: 'string', description: 'btree (default), hash, gist, gin, brin or spgist.' },
        schema: { type: 'string', description: 'Defaults to public.' },
      },
      required: ['table', 'columns'],
    },
    mode: 'write',
    http: { method: 'POST', path: '/schema/tables/{table}/indexes' },
  },
  {
    name: 'create_policy',
    description:
      'Create one row level security policy on an existing table. Always proposed to the operator for approval ' +
      'before it runs. Enable RLS on the table first if it is not already on (ask the operator, or check rls_status).',
    input: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        name: { type: 'string', description: 'Policy name, e.g. "customers_owner_read".' },
        command: { type: 'string', description: 'SELECT, INSERT, UPDATE, DELETE or ALL.' },
        role: { type: 'string', description: 'anon or authenticated.' },
        using: { type: 'string', description: 'USING expression, e.g. "user_id = auth.uid()".' },
        check: { type: 'string', description: 'WITH CHECK expression, for INSERT/UPDATE/ALL.' },
      },
      required: ['table', 'name', 'command', 'role'],
    },
    mode: 'write',
    http: { method: 'POST', path: '/rls/policies' },
  },
];

/** Every tool the agent may call: reads execute immediately, writes are proposed. */
export const ALL_TOOLS: ToolSpec[] = [...READ_TOOLS, ...WRITE_TOOLS];

export function toolByName(name: string): ToolSpec | undefined {
  return ALL_TOOLS.find(t => t.name === name);
}
