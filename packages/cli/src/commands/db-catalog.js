'use strict';

// `motherbase db indexes|types|roles|publications`: the Database section of
// Studio from the terminal. Supabase's CLI has no equivalent for these, so they
// live under `db` rather than claiming top-level names Supabase might use.

const api = require('../api');
const { output, requireArg } = require('./_util');
const { CliError } = require('../context');

const schemaQuery = flags => (flags.schema ? { schema: flags.schema } : undefined);
const csv = value => String(value).split(',').map(s => s.trim()).filter(Boolean);

// `--login`, `--login true` and `--login false` all read naturally; absent
// means "leave as is", which ALTER ROLE needs to change one attribute only.
function bool(value) {
  if (value === undefined) return undefined;
  return value === true || value === 'true';
}

// Parse `schema.table` (or a bare `table` in public) into the API's shape.
function tableRef(ref) {
  const [schema, table] = ref.includes('.') ? ref.split('.', 2) : ['public', ref];
  return { schema, table };
}

function roleAttributes(flags) {
  const attributes = {
    canLogin: bool(flags.login),
    isSuperuser: bool(flags.superuser),
    canCreateDb: bool(flags.createdb),
    canCreateRole: bool(flags.createrole),
    canReplicate: bool(flags.replication),
    canBypassRls: bool(flags.bypassrls),
    inheritRole: bool(flags.inherit),
    connectionLimit: flags['connection-limit'] === undefined ? undefined : Number(flags['connection-limit']),
    password: typeof flags.password === 'string' ? flags.password : undefined,
    validUntil: flags['valid-until'] === undefined ? undefined : String(flags['valid-until']),
  };
  return Object.fromEntries(Object.entries(attributes).filter(([, v]) => v !== undefined));
}

function publishFlags(flags, defaults) {
  const actions = flags.publish === undefined ? null : csv(flags.publish);
  if (!actions) return defaults;
  return Object.fromEntries(['insert', 'update', 'delete', 'truncate'].map(a => [a, actions.includes(a)]));
}

const indexes = {
  summary: 'Indexes across a schema: list, create, drop',
  usage: 'motherbase db indexes <list|create|drop> ...',
  subcommands: {
    list: {
      summary: 'List every index in a schema',
      usage: 'motherbase db indexes list [--schema public]',
      async run(ctx, args, flags) {
        const data = await api.adminRequest(ctx, 'GET', '/schema/indexes', { query: schemaQuery(flags) });
        output(ctx, data, (d, ui) =>
          ui.table((d.indexes || []).map(i => ({ ...i, columns: i.columns.join(', ') })), [
            { key: 'table', label: 'TABLE' },
            { key: 'name', label: 'INDEX' },
            { key: 'method', label: 'METHOD' },
            { key: 'unique', label: 'UNIQUE' },
            { key: 'columns', label: 'COLUMNS' },
            { key: 'sizeBytes', label: 'BYTES' },
          ]),
        );
      },
    },
    create: {
      summary: 'Create an index on one or more columns',
      usage: 'motherbase db indexes create <table> --columns a,b [--unique] [--method btree|hash|gist|gin|brin|spgist] [--name n] [--schema s]',
      async run(ctx, args, flags) {
        const table = requireArg(args[0], 'table');
        if (!flags.columns) throw new CliError('--columns is required');
        const body = { columns: csv(flags.columns), unique: bool(flags.unique) || false };
        if (flags.method) body.method = String(flags.method);
        if (flags.name) body.name = String(flags.name);
        const data = await api.adminRequest(ctx, 'POST', `/schema/tables/${encodeURIComponent(table)}/indexes`, { body, query: schemaQuery(flags) });
        output(ctx, data, (_d, ui) => ui.success(`Created index on ${table} (${body.columns.join(', ')})`));
      },
    },
    drop: {
      summary: 'Drop an index by name',
      usage: 'motherbase db indexes drop <name> [--schema s]',
      async run(ctx, args, flags) {
        const name = requireArg(args[0], 'name');
        const data = await api.adminRequest(ctx, 'DELETE', `/schema/indexes/${encodeURIComponent(name)}`, { query: schemaQuery(flags) });
        output(ctx, data, (_d, ui) => ui.success(`Dropped index ${name}`));
      },
    },
  },
};

const enumPath = name => `/schema/enums/${encodeURIComponent(name)}`;

const types = {
  summary: 'Enumerated types: list, create, add-value, rename-value, drop',
  usage: 'motherbase db types <list|create|add-value|rename-value|drop> ...',
  subcommands: {
    list: {
      summary: 'List enum types and their values',
      usage: 'motherbase db types list [--schema public]',
      async run(ctx, args, flags) {
        const data = await api.adminRequest(ctx, 'GET', '/schema/enums', { query: schemaQuery(flags) });
        output(ctx, data, (d, ui) =>
          ui.table((d.enums || []).map(e => ({ name: e.name, values: e.values.join(', '), usedBy: e.usedBy.length })), [
            { key: 'name', label: 'TYPE' },
            { key: 'values', label: 'VALUES' },
            { key: 'usedBy', label: 'COLUMNS' },
          ]),
        );
      },
    },
    create: {
      summary: 'Create an enum type',
      usage: 'motherbase db types create <name> --values a,b,c [--schema s]',
      async run(ctx, args, flags) {
        const name = requireArg(args[0], 'name');
        if (!flags.values) throw new CliError('--values is required');
        const data = await api.adminRequest(ctx, 'POST', '/schema/enums', { body: { name, values: csv(flags.values) }, query: schemaQuery(flags) });
        output(ctx, data, (_d, ui) => ui.success(`Created type ${name}`));
      },
    },
    'add-value': {
      summary: 'Add a value to an enum (values cannot be removed)',
      usage: 'motherbase db types add-value <name> <value> [--before v | --after v] [--schema s]',
      async run(ctx, args, flags) {
        const name = requireArg(args[0], 'name');
        const value = requireArg(args[1], 'value');
        const body = { action: 'add-value', value, before: flags.before, after: flags.after };
        const data = await api.adminRequest(ctx, 'PATCH', enumPath(name), { body, query: schemaQuery(flags) });
        output(ctx, data, (_d, ui) => ui.success(`Added "${value}" to ${name}`));
      },
    },
    'rename-value': {
      summary: 'Rename one value of an enum',
      usage: 'motherbase db types rename-value <name> <from> <to> [--schema s]',
      async run(ctx, args, flags) {
        const name = requireArg(args[0], 'name');
        const body = { action: 'rename-value', from: requireArg(args[1], 'from'), to: requireArg(args[2], 'to') };
        const data = await api.adminRequest(ctx, 'PATCH', enumPath(name), { body, query: schemaQuery(flags) });
        output(ctx, data, (_d, ui) => ui.success(`Renamed "${body.from}" to "${body.to}" in ${name}`));
      },
    },
    drop: {
      summary: 'Drop an enum type (refused while a column uses it)',
      usage: 'motherbase db types drop <name> [--schema s]',
      async run(ctx, args, flags) {
        const name = requireArg(args[0], 'name');
        const data = await api.adminRequest(ctx, 'DELETE', enumPath(name), { query: schemaQuery(flags) });
        output(ctx, data, (_d, ui) => ui.success(`Dropped type ${name}`));
      },
    },
  },
};

const ROLE_FLAGS = '[--login] [--password p] [--createdb] [--createrole] [--replication] [--bypassrls] [--superuser] [--connection-limit n] [--valid-until iso]';

const roles = {
  summary: 'Postgres roles: list, create, alter, drop',
  usage: 'motherbase db roles <list|create|alter|drop> ...',
  subcommands: {
    list: {
      summary: 'List roles with their attributes and live connections',
      usage: 'motherbase db roles list',
      async run(ctx) {
        const data = await api.adminRequest(ctx, 'GET', '/database/roles');
        output(ctx, data, (d, ui) =>
          ui.table(d.roles || [], [
            { key: 'name', label: 'ROLE' },
            { key: 'canLogin', label: 'LOGIN' },
            { key: 'isSuperuser', label: 'SUPERUSER' },
            { key: 'canBypassRls', label: 'BYPASSRLS' },
            { key: 'connectionLimit', label: 'LIMIT' },
            { key: 'activeConnections', label: 'CONNECTIONS' },
            { key: 'reserved', label: 'RESERVED' },
          ]),
        );
      },
    },
    create: {
      summary: 'Create a role',
      usage: `motherbase db roles create <name> ${ROLE_FLAGS}`,
      async run(ctx, args, flags) {
        const name = requireArg(args[0], 'name');
        const data = await api.adminRequest(ctx, 'POST', '/database/roles', { body: { name, ...roleAttributes(flags) } });
        output(ctx, data, (_d, ui) => ui.success(`Created role ${name}`));
      },
    },
    alter: {
      summary: 'Change attributes of a role, or rename it with --rename',
      usage: `motherbase db roles alter <name> [--rename new] ${ROLE_FLAGS}`,
      async run(ctx, args, flags) {
        const name = requireArg(args[0], 'name');
        const body = { ...roleAttributes(flags), ...(flags.rename ? { name: String(flags.rename) } : {}) };
        if (!Object.keys(body).length) throw new CliError('Nothing to change: pass at least one attribute flag.');
        const data = await api.adminRequest(ctx, 'PATCH', `/database/roles/${encodeURIComponent(name)}`, { body });
        output(ctx, data, (_d, ui) => ui.success(`Updated role ${name}`));
      },
    },
    drop: {
      summary: 'Drop a role (refused for reserved roles and roles that own objects)',
      usage: 'motherbase db roles drop <name>',
      async run(ctx, args) {
        const name = requireArg(args[0], 'name');
        const data = await api.adminRequest(ctx, 'DELETE', `/database/roles/${encodeURIComponent(name)}`);
        output(ctx, data, (_d, ui) => ui.success(`Dropped role ${name}`));
      },
    },
  },
};

const publications = {
  summary: 'Logical-replication publications: list, create, alter, drop',
  usage: 'motherbase db publications <list|create|alter|drop> ...',
  subcommands: {
    list: {
      summary: 'List publications, their tables and published actions',
      usage: 'motherbase db publications list',
      async run(ctx) {
        const data = await api.adminRequest(ctx, 'GET', '/database/publications');
        output(ctx, data, (d, ui) => {
          ui.table((d.publications || []).map(p => ({
            name: p.name,
            publish: ['insert', 'update', 'delete', 'truncate'].filter(a => p[a]).join(', '),
            tables: p.allTables ? '(all tables)' : p.tables.map(t => `${t.schema}.${t.table}`).join(', '),
          })), [
            { key: 'name', label: 'PUBLICATION' },
            { key: 'publish', label: 'PUBLISH' },
            { key: 'tables', label: 'TABLES' },
          ]);
          if (d.walLevel !== 'logical') ui.warn(`wal_level is "${d.walLevel}": publications stream nothing until it is "logical".`);
        });
      },
    },
    create: {
      summary: 'Create a publication',
      usage: 'motherbase db publications create <name> [--tables a,schema.b | --all-tables] [--publish insert,update,delete,truncate]',
      async run(ctx, args, flags) {
        const name = requireArg(args[0], 'name');
        const body = {
          name,
          ...publishFlags(flags, { insert: true, update: true, delete: true, truncate: true }),
          ...(flags['all-tables'] ? { allTables: true } : {}),
          ...(flags.tables ? { tables: csv(flags.tables).map(tableRef) } : {}),
        };
        const data = await api.adminRequest(ctx, 'POST', '/database/publications', { body });
        output(ctx, data, (_d, ui) => ui.success(`Created publication ${name}`));
      },
    },
    alter: {
      summary: 'Add or drop tables, or change what is published',
      usage: 'motherbase db publications alter <name> [--add a,schema.b] [--drop c] [--publish insert,update]',
      async run(ctx, args, flags) {
        const name = requireArg(args[0], 'name');
        const body = {
          ...publishFlags(flags, {}),
          ...(flags.add ? { addTables: csv(flags.add).map(tableRef) } : {}),
          ...(flags.drop ? { dropTables: csv(flags.drop).map(tableRef) } : {}),
        };
        if (!Object.keys(body).length) throw new CliError('Nothing to change: pass --add, --drop or --publish.');
        const data = await api.adminRequest(ctx, 'PATCH', `/database/publications/${encodeURIComponent(name)}`, { body });
        output(ctx, data, (_d, ui) => ui.success(`Updated publication ${name}`));
      },
    },
    drop: {
      summary: 'Drop a publication',
      usage: 'motherbase db publications drop <name>',
      async run(ctx, args) {
        const name = requireArg(args[0], 'name');
        const data = await api.adminRequest(ctx, 'DELETE', `/database/publications/${encodeURIComponent(name)}`);
        output(ctx, data, (_d, ui) => ui.success(`Dropped publication ${name}`));
      },
    },
  },
};

function privilegeChange(grant) {
  return {
    summary: `${grant ? 'Grant' : 'Revoke'} a column privilege for a role`,
    usage: `motherbase db column-privileges ${grant ? 'grant' : 'revoke'} <[schema.]table> --role r --privilege select|insert|update|references --columns a,b`,
    async run(ctx, args, flags) {
      const { schema, table } = tableRef(requireArg(args[0], 'table'));
      if (!flags.role || !flags.privilege || !flags.columns) throw new CliError('--role, --privilege and --columns are required');
      const body = {
        schema,
        table,
        role: String(flags.role),
        privilege: String(flags.privilege).toUpperCase(),
        columns: csv(flags.columns),
        grant,
      };
      const data = await api.adminRequest(ctx, 'PUT', '/database/column-privileges', { body });
      output(ctx, data, (_d, ui) => ui.success(`${grant ? 'Granted' : 'Revoked'} ${body.privilege} on ${body.columns.join(', ')} ${grant ? 'to' : 'from'} ${body.role}`));
    },
  };
}

const columnPrivileges = {
  summary: 'Column-level GRANT / REVOKE per role',
  usage: 'motherbase db column-privileges <list|grant|revoke> <[schema.]table> ...',
  subcommands: {
    list: {
      summary: 'Show which columns each role may select, insert, update or reference',
      usage: 'motherbase db column-privileges list <[schema.]table>',
      async run(ctx, args) {
        const query = tableRef(requireArg(args[0], 'table'));
        const data = await api.adminRequest(ctx, 'GET', '/database/column-privileges', { query });
        output(ctx, data, (d, ui) =>
          ui.table((d.roles || []).map(r => ({
            role: r.role,
            ...Object.fromEntries(Object.entries(r.privileges).map(([privilege, p]) => [
              privilege,
              p.tableLevel ? '(all)' : p.columns.join(', '),
            ])),
          })), ['role', 'SELECT', 'INSERT', 'UPDATE', 'REFERENCES']),
        );
      },
    },
    grant: privilegeChange(true),
    revoke: privilegeChange(false),
  },
};

const cron = {
  summary: 'Manage pg_cron jobs',
  usage: 'motherbase db cron <list|get|run|create>',
  subcommands: {
    list: {
      summary: 'List cron jobs',
      usage: 'motherbase db cron list',
      async run(ctx) {
        const data = await api.adminRequest(ctx, 'GET', '/cron/pg/jobs');
        output(ctx, data, (d, ui) => ui.table(d.jobs || [], ['jobid', 'jobname', 'schedule', 'active']));
      },
    },
    get: {
      summary: 'Get a cron job by id',
      usage: 'motherbase db cron get <id>',
      async run(ctx, args) {
        const id = requireArg(args[0], 'id');
        const data = await api.adminRequest(ctx, 'GET', `/cron/pg/jobs/${encodeURIComponent(id)}`);
        output(ctx, data, (d, ui) => ui.table([d.job]));
      },
    },
    run: {
      summary: 'Run a cron job once, now, to test it',
      usage: 'motherbase db cron run <id>',
      async run(ctx, args) {
        const id = requireArg(args[0], 'id');
        const data = await api.adminRequest(ctx, 'POST', `/cron/pg/jobs/${encodeURIComponent(id)}/run`);
        output(ctx, data, (d, ui) => ui.success(`Ran cron job ${id} in ${d.durationMs}ms (${d.rowsAffected} rows affected)`));
      },
    },
    create: {
      summary: 'Create a cron job',
      usage: 'motherbase db cron create <name> --schedule <cron> --command <sql>',
      async run(ctx, args, flags) {
        const name = requireArg(args[0], 'name');
        if (!flags.schedule || !flags.command) throw new CliError('--schedule and --command are required');
        const body = { name, schedule: flags.schedule, command: flags.command };
        const data = await api.adminRequest(ctx, 'POST', '/cron/pg/jobs', { body });
        output(ctx, data, (d, ui) => ui.success(`Created cron job ${name}`));
      },
    },
  },
};

module.exports = { indexes, types, roles, 'column-privileges': columnPrivileges, publications, cron};
