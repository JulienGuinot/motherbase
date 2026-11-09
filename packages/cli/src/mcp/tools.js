'use strict';

// The tools an agent gets over MCP.
//
// Every one is a call through the CLI's own HTTP layer: `api.adminRequest` for
// the project, `api.consoleRequest` for the account tools in platform-tools.js,
// the same paths every CLI command takes. That is the whole design: authentication,
// console-proxy vs direct mode, and error mapping are solved once in the CLI and
// reused here, so an MCP session cannot reach anything a `motherbase` command
// could not, and cannot drift from it either.
//
// The gap this closes is the one self-hosters name about Supabase's MCP: "DDL
// statements not supported". `apply_migration` runs DDL, because the admin API
// this is built on already does.

const api = require('../api');
const platform = require('./platform-tools');
const storage = require('./storage-tools');
const { consoleProjectPath } = require('../commands/_util');

const str = description => ({ type: 'string', description });

/** Tools that only read. Safe to run without confirmation. */
function readTools(ctx) {
  return [
    {
      name: 'list_tables',
      description: 'List the tables in the project database, with their columns and row counts.',
      inputSchema: { type: 'object', properties: {} },
      run: () => api.adminRequest(ctx, 'GET', '/tables'),
    },
    {
      name: 'describe_table',
      description: 'Columns, types, nullability, defaults, primary key and indexes of one table.',
      inputSchema: {
        type: 'object',
        properties: { table: str('Table name, in the public schema.') },
        required: ['table'],
      },
      run: async args => {
        const [tables, indexes] = await Promise.all([
          api.adminRequest(ctx, 'GET', '/schema/tables'),
          api.adminRequest(ctx, 'GET', `/schema/tables/${encodeURIComponent(args.table)}/indexes`),
        ]);
        const list = Array.isArray(tables) ? tables : tables && tables.tables;
        const table = (list || []).find(t => t.name === args.table || t.table === args.table);
        if (!table) throw new Error(`No table named "${args.table}" in the public schema.`);
        return { ...table, indexes };
      },
    },
    {
      name: 'list_policies',
      description:
        'Row level security state for every table: whether RLS is on, and the policies attached with their USING and WITH CHECK expressions.',
      inputSchema: { type: 'object', properties: {} },
      run: () => api.adminRequest(ctx, 'GET', '/rls/tables'),
    },
    {
      name: 'simulate_rls',
      description:
        'Run a SELECT as a given caller and report the rows they can see plus the policies that decided. The statement really executes, inside a transaction that is always rolled back.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: str('A single SELECT statement.'),
          role: str("'anon' or 'authenticated'. Ignored when userId is given."),
          userId: str('Run as this existing user instead of a bare role.'),
        },
        required: ['sql'],
      },
      run: args =>
        api.adminRequest(ctx, 'POST', '/rls/simulate', {
          body: { sql: args.sql, role: args.role, userId: args.userId },
        }),
    },
    {
      name: 'get_advisors',
      description:
        'Lint the schema and policies: tables exposed with RLS off, RLS on with no policy, policies that leak through a join, SECURITY DEFINER functions anon can call, unindexed policy columns.',
      inputSchema: { type: 'object', properties: {} },
      run: () => api.adminRequest(ctx, 'GET', '/advisor'),
    },
    {
      name: 'get_logs',
      description: 'Recent log entries of one service, or of all of them.',
      inputSchema: {
        type: 'object',
        properties: {
          service: {
            type: 'string',
            enum: ['api', 'postgres', 'auth', 'storage', 'realtime', 'edge-function'],
            description: 'Only this service. api is every HTTP request. Omit for all services.',
          },
          limit: { type: 'number', description: 'How many entries. Defaults to 100.' },
          level: str("Filter by level: 'info', 'warn' or 'error'."),
        },
      },
      run: args =>
        api.adminRequest(ctx, 'GET', '/logs', {
          query: { limit: args.limit || 100, level: args.level, service: args.service },
        }),
    },
    {
      name: 'generate_types',
      description:
        'TypeScript types for the whole schema, in the supabase-js Database shape. The same output as `motherbase gen types typescript`.',
      inputSchema: { type: 'object', properties: {} },
      run: () => api.adminRequest(ctx, 'GET', '/schema/types'),
    },
    {
      name: 'execute_sql',
      description:
        'Run a read-only SQL query. Statements that write are refused: use apply_migration for those.',
      inputSchema: {
        type: 'object',
        properties: { sql: str('A read-only SQL statement.') },
        required: ['sql'],
      },
      // The read-only endpoint, not /sql: a tool the model reaches for by default
      // must not be able to write, whatever the model believed it was doing.
      run: args => api.adminRequest(ctx, 'POST', '/sql/readonly', { body: { sql: args.sql } }),
    },

    // ── db-core: Database section (indexes, enums, roles, publications, config) ──
    {
      name: 'list_indexes',
      description: 'Every index in a schema, with its table, access method, key columns, uniqueness, size and definition.',
      inputSchema: { type: 'object', properties: { schema: str('Postgres schema. Defaults to public.') } },
      run: args => api.adminRequest(ctx, 'GET', '/schema/indexes', { query: { schema: args.schema } }),
    },
    {
      name: 'list_enum_types',
      description: 'Enumerated types in a schema, with their values in order and the columns that use each one.',
      inputSchema: { type: 'object', properties: { schema: str('Postgres schema. Defaults to public.') } },
      run: args => api.adminRequest(ctx, 'GET', '/schema/enums', { query: { schema: args.schema } }),
    },
    {
      name: 'list_roles',
      description:
        'Postgres roles with their attributes (login, superuser, bypassrls, connection limit), live connections and memberships. Reserved platform roles carry the reason they cannot be changed.',
      inputSchema: { type: 'object', properties: {} },
      run: () => api.adminRequest(ctx, 'GET', '/database/roles'),
    },
    {
      name: 'list_column_privileges',
      description: 'For one table, which columns each role may SELECT, INSERT, UPDATE or REFERENCE.',
      inputSchema: {
        type: 'object',
        properties: { table: str('Table name.'), schema: str('Postgres schema. Defaults to public.') },
        required: ['table'],
      },
      run: args => api.adminRequest(ctx, 'GET', '/database/column-privileges', { query: { table: args.table, schema: args.schema } }),
    },
    {
      name: 'list_publications',
      description:
        'Logical-replication publications, their tables and published actions, and wal_level. Motherbase Realtime does not use publications.',
      inputSchema: { type: 'object', properties: {} },
      run: () => api.adminRequest(ctx, 'GET', '/database/publications'),
    },
    {
      name: 'get_postgres_config',
      description:
        'Managed Postgres settings (statement_timeout, work_mem, max_connections, ...) with current values, allowed scopes and every database, role or system override.',
      inputSchema: { type: 'object', properties: {} },
      run: () => api.adminRequest(ctx, 'GET', '/database/config'),
    },
    // ── end db-core ──

    // ── cli-mcp lot: Supabase MCP project tools (platform-tools.js) ──────────
    ...platform.projectReadTools(ctx),
    // ── Lot platform: preview branches (Console routes, console mode only) ──
    {
      name: 'list_branches',
      description:
        'The preview branches of the linked project, main first, with status (creating, seeding, active, failed) and whether each is running.',
      inputSchema: { type: 'object', properties: {} },
      run: () => api.consoleRequest(ctx, 'GET', consoleProjectPath(ctx, '/branches')),
    },

    // ── db-ext ──────────────────────────────────────────────────────────────
    {
      name: 'list_queues',
      description: 'List the message queues (pgmq) with their depth, type and whether RLS is on. Empty when queues are not enabled.',
      inputSchema: { type: 'object', properties: {} },
      run: () => api.adminRequest(ctx, 'GET', '/queues'),
    },
    {
      name: 'list_vault_secrets',
      description: 'List the Vault secrets: id, name, description and dates. Never returns a secret value.',
      inputSchema: { type: 'object', properties: {} },
      run: () => api.adminRequest(ctx, 'GET', '/vault'),
    },
    {
      name: 'list_wrappers',
      description: 'List the foreign data wrappers, foreign servers (never their passwords) and foreign tables.',
      inputSchema: { type: 'object', properties: {} },
      run: () => api.adminRequest(ctx, 'GET', '/wrappers'),
    },
    {
      name: 'advise_indexes',
      description:
        'Suggest indexes for one SELECT/UPDATE/DELETE statement: the CREATE INDEX statements and the estimated cost drop. The statement is only planned over hypothetical indexes, never run.',
      inputSchema: {
        type: 'object',
        properties: { sql: str('The statement to advise on.') },
        required: ['sql'],
      },
      run: args => api.adminRequest(ctx, 'POST', '/performance/index-advisor', { body: { query: args.sql } }),
    },
    // ── /db-ext ─────────────────────────────────────────────────────────────

    // ── auth ──
    {
      name: 'get_auth_config',
      description:
        'Every auth.* settings group (sign-in methods, URL configuration, rate limits, attack protection, third-party auth, hooks...) with its current values. Secrets are masked.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        const list = await api.adminRequest(ctx, 'GET', '/settings');
        const keys = ((list && list.groups) || []).map(g => g.key).filter(key => key.startsWith('auth.'));
        const groups = await Promise.all(keys.map(key => api.adminRequest(ctx, 'GET', `/settings/${key}`)));
        return { groups };
      },
    },
    {
      name: 'get_auth_audit_logs',
      description:
        'Auth audit trail (auth.audit_log_entries), newest first: sign-ins, sign-ups, token refreshes, recoveries, admin changes. Same data as the Studio Audit Logs page.',
      inputSchema: {
        type: 'object',
        properties: {
          action: str("Filter by action, e.g. 'login', 'user_signedup', 'user_deleted'."),
          actor: str('Substring of the actor id or email.'),
          logType: str("Filter by log type: 'account', 'team', 'token', 'user'..."),
          from: str('ISO date; only entries at or after it.'),
          to: str('ISO date; only entries at or before it.'),
          limit: { type: 'number', description: 'How many entries. Defaults to 50.' },
        },
      },
      run: args =>
        api.adminRequest(ctx, 'GET', '/auth/audit-logs', {
          query: {
            action: args.action,
            actor: args.actor,
            log_type: args.logType,
            from: args.from,
            to: args.to,
            per_page: args.limit || 50,
          },
        }),
    },
    // ── /auth ──

    // ── storage ──────────────────────────────────────────────────────────────
    ...storage.readStorageTools(ctx),
    // ── /storage ─────────────────────────────────────────────────────────────
  ];
}

/** `/branches/<name>/<action>` on the linked project. */
const branchAction = (ctx, action) => args =>
  api.consoleRequest(ctx, 'POST', consoleProjectPath(ctx, `/branches/${encodeURIComponent(args.name)}/${action}`));

/** Tools that change the database. Only exposed with `--write`. */
function writeTools(ctx) {
  return [
    {
      name: 'apply_migration',
      description:
        'Create a named migration from DDL and apply it. This is the tool for CREATE TABLE, ALTER TABLE, CREATE POLICY and every other schema change. The migration is recorded, so it can be rolled back.',
      inputSchema: {
        type: 'object',
        properties: {
          name: str('Short migration name, e.g. add_orders_table.'),
          sql: str('The DDL to apply.'),
          downSql: str('Optional SQL that undoes it, enabling rollback.'),
        },
        required: ['name', 'sql'],
      },
      run: async args => {
        const created = await api.adminRequest(ctx, 'POST', '/migrations', {
          body: { name: args.name, upSql: args.sql, downSql: args.downSql },
        });
        const id = created && (created.id || (created.migration && created.migration.id));
        if (!id) throw new Error('The migration was created but the server returned no id to apply.');
        const applied = await api.adminRequest(ctx, 'POST', `/migrations/${encodeURIComponent(id)}/apply`);
        return { id, applied };
      },
    },
    {
      name: 'execute_sql_write',
      description:
        'Run arbitrary SQL, including writes. Prefer apply_migration for schema changes: this leaves no record and cannot be rolled back.',
      inputSchema: {
        type: 'object',
        properties: { sql: str('The SQL to run.') },
        required: ['sql'],
      },
      run: args => api.adminRequest(ctx, 'POST', '/sql', { body: { sql: args.sql } }),
    },

    // ── db-core: Postgres settings ──────────────────────────────────────────
    // A dedicated tool rather than execute_sql_write: the server checks the
    // name against its curated list and picks the narrowest scope Postgres allows.
    {
      name: 'update_postgres_config',
      description:
        'Set or reset (value null) managed Postgres settings. Without scope, a session setting such as statement_timeout is pinned on the database; server-wide ones use ALTER SYSTEM and may need a restart, which the result reports.',
      inputSchema: {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: str('Setting name, e.g. statement_timeout.'),
                value: { type: ['string', 'null'], description: "New value with its unit, e.g. '30s', or null to reset." },
                scope: str("'database', 'role' or 'system'. Optional."),
                role: str('Role name, for scope role.'),
              },
              required: ['name', 'value'],
            },
          },
        },
        required: ['changes'],
      },
      run: args => api.adminRequest(ctx, 'PATCH', '/database/config', { body: { changes: args.changes } }),
    },
    // ── end db-core ──

    // ── cli-mcp lot: Supabase MCP project tools (platform-tools.js) ──────────
    ...platform.projectWriteTools(ctx),
    // ── Lot platform: preview branches (Console routes, console mode only) ──
    {
      name: 'create_branch',
      description:
        'Create a preview branch: an isolated copy of the project with its own database, cut from its applied migrations (or its data with withData). Takes minutes; poll list_branches until it is active.',
      inputSchema: {
        type: 'object',
        properties: {
          name: str('Branch name, e.g. the git branch.'),
          withData: { type: 'boolean', description: 'Copy the rows too, not only the schema. Defaults to false.' },
        },
        required: ['name'],
      },
      run: args =>
        api.consoleRequest(ctx, 'POST', consoleProjectPath(ctx, '/branches'), {
          body: { name: args.name, withData: Boolean(args.withData) },
        }),
    },
    {
      name: 'delete_branch',
      description: 'Delete a preview branch and its whole stack.',
      inputSchema: { type: 'object', properties: { name: str('Branch name.') }, required: ['name'] },
      run: args =>
        api.consoleRequest(ctx, 'DELETE', consoleProjectPath(ctx, `/branches/${encodeURIComponent(args.name)}`)),
    },
    {
      name: 'merge_branch',
      description:
        "Apply the branch's new migrations to the main project. Refused while the branch is behind main: rebase_branch first.",
      inputSchema: { type: 'object', properties: { name: str('Branch name.') }, required: ['name'] },
      run: branchAction(ctx, 'merge'),
    },
    {
      name: 'rebase_branch',
      description: "Apply the main project's newer migrations to the branch.",
      inputSchema: { type: 'object', properties: { name: str('Branch name.') }, required: ['name'] },
      run: branchAction(ctx, 'rebase'),
    },
    {
      name: 'reset_branch',
      description: 'Recreate the branch from the main project as it is now. Everything done on the branch is lost.',
      inputSchema: { type: 'object', properties: { name: str('Branch name.') }, required: ['name'] },
      run: branchAction(ctx, 'reset'),
    },

    // ── db-ext ──────────────────────────────────────────────────────────────
    {
      name: 'create_queue',
      description: 'Create a message queue (pgmq).',
      inputSchema: {
        type: 'object',
        properties: {
          name: str('Queue name.'),
          type: str("'basic' (default), 'unlogged' or 'partitioned'."),
        },
        required: ['name'],
      },
      run: args => api.adminRequest(ctx, 'POST', '/queues', { body: { name: args.name, type: args.type } }),
    },
    {
      name: 'drop_queue',
      description: 'Drop a queue and every message in it. Cannot be undone.',
      inputSchema: { type: 'object', properties: { name: str('Queue name.') }, required: ['name'] },
      run: args => api.adminRequest(ctx, 'DELETE', `/queues/${encodeURIComponent(args.name)}`),
    },
    {
      name: 'send_queue_message',
      description: 'Send a JSON message to a queue.',
      inputSchema: {
        type: 'object',
        properties: {
          name: str('Queue name.'),
          message: { description: 'Any JSON value.' },
          delay: { type: 'number', description: 'Seconds before the message becomes visible. Defaults to 0.' },
        },
        required: ['name', 'message'],
      },
      run: args =>
        api.adminRequest(ctx, 'POST', `/queues/${encodeURIComponent(args.name)}/messages`, {
          body: { message: args.message, delay: args.delay },
        }),
    },
    {
      name: 'read_queue_messages',
      description:
        'Read messages from a queue. A write, because it hides them from other readers for the visibility timeout.',
      inputSchema: {
        type: 'object',
        properties: {
          name: str('Queue name.'),
          qty: { type: 'number', description: 'How many messages, 1 to 100. Defaults to 1.' },
          vt: { type: 'number', description: 'Visibility timeout in seconds. Defaults to 30.' },
        },
        required: ['name'],
      },
      run: args =>
        api.adminRequest(ctx, 'POST', `/queues/${encodeURIComponent(args.name)}/read`, {
          body: { qty: args.qty, vt: args.vt },
        }),
    },
    {
      name: 'create_vault_secret',
      description: 'Store an encrypted secret in the Vault. There is no tool that reads a value back.',
      inputSchema: {
        type: 'object',
        properties: { name: str('Unique secret name.'), secret: str('The value.'), description: str('Optional note.') },
        required: ['name', 'secret'],
      },
      run: args =>
        api.adminRequest(ctx, 'POST', '/vault/secrets', {
          body: { name: args.name, secret: args.secret, description: args.description },
        }),
    },
    {
      name: 'delete_vault_secret',
      description: 'Delete a Vault secret by id. Cannot be undone.',
      inputSchema: { type: 'object', properties: { id: str('Secret id, from list_vault_secrets.') }, required: ['id'] },
      run: args => api.adminRequest(ctx, 'DELETE', `/vault/secrets/${encodeURIComponent(args.id)}`),
    },
    // ── /db-ext ─────────────────────────────────────────────────────────────

    // ── storage ──────────────────────────────────────────────────────────────
    ...storage.writeStorageTools(ctx),
    // ── /storage ─────────────────────────────────────────────────────────────
  ];
}

/**
 * `write` defaults to false, so an agent that connects without being told
 * otherwise can read the schema, lint it and simulate policies, but cannot
 * change anything. Handing an agent DDL is a decision the operator makes.
 *
 * `project` and `console` say what this session can reach: the project tools
 * need a linked (or direct) project, the account tools a console login, and a
 * tool that can only fail is left out rather than offered.
 */
function buildTools(ctx, { write = false, project = true, console = false } = {}) {
  const tools = [];
  if (project) tools.push(...readTools(ctx), ...(write ? writeTools(ctx) : []));
  if (console) tools.push(...platform.consoleReadTools(ctx), ...(write ? platform.consoleWriteTools(ctx) : []));
  return tools;
}

module.exports = { buildTools, readTools, writeTools };
