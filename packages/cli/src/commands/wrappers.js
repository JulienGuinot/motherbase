'use strict';

const api = require('../api');
const { output, requireArg, parseKeyValues } = require('./_util');
const { CliError } = require('../context');

const enc = encodeURIComponent;

// `--option host=db.example.com --option port=5432`, repeatable.
function options(flags) {
  return parseKeyValues([].concat(flags.option || []), { coerce: false });
}

// `schema.name` -> [schema, name]
function qualified(ref) {
  const [schema, name, ...rest] = requireArg(ref, 'schema.table').split('.');
  if (!schema || !name || rest.length) throw new CliError('expected <schema>.<table>');
  return [schema, name];
}

// `--column id:integer --column label:text`, repeatable.
function columns(flags) {
  const specs = [].concat(flags.column || []);
  if (!specs.length) throw new CliError('at least one --column <name>:<type> is required');
  return specs.map(spec => {
    const idx = String(spec).indexOf(':');
    if (idx <= 0) throw new CliError(`expected <name>:<type>, got "${spec}"`);
    return { name: spec.slice(0, idx), type: spec.slice(idx + 1) };
  });
}

const subcommands = {
  list: {
    summary: 'List wrappers, foreign servers and foreign tables',
    usage: 'motherbase wrappers list',
    async run(ctx) {
      const data = await api.adminRequest(ctx, 'GET', '/wrappers');
      output(ctx, data, (d, ui) => {
        ui.table((d && d.wrappers) || [], [
          { key: 'name', label: 'WRAPPER' },
          { key: 'available', label: 'AVAILABLE' },
          { key: 'installed', label: 'INSTALLED' },
        ]);
        ui.table((d && d.servers) || [], [
          { key: 'name', label: 'SERVER' },
          { key: 'wrapper', label: 'WRAPPER' },
          { key: 'remoteUser', label: 'REMOTE USER' },
          { key: 'foreignTables', label: 'TABLES' },
        ]);
        ui.table((d && d.tables) || [], [
          { key: 'schema', label: 'SCHEMA' },
          { key: 'name', label: 'TABLE' },
          { key: 'server', label: 'SERVER' },
          { key: 'columns', label: 'COLUMNS' },
        ]);
      });
    },
  },
  enable: {
    summary: 'Install a wrapper extension',
    usage: 'motherbase wrappers enable <postgres_fdw|file_fdw>',
    async run(ctx, args) {
      const wrapper = requireArg(args[0], 'wrapper');
      const data = await api.adminRequest(ctx, 'POST', `/wrappers/${enc(wrapper)}/enable`);
      output(ctx, data, (_d, ui) => ui.success(`Enabled ${wrapper}`));
    },
  },
  'create-server': {
    summary: 'Create a foreign server; the password goes to the Vault',
    usage:
      'motherbase wrappers create-server <name> --wrapper <postgres_fdw|file_fdw> [--option k=v ...] [--user <u> --password <p>]',
    async run(ctx, args, flags) {
      const name = requireArg(args[0], 'name');
      const body = { name, wrapper: requireArg(flags.wrapper, '--wrapper'), options: options(flags) };
      if (typeof flags.user === 'string') body.user = flags.user;
      if (typeof flags.password === 'string') body.password = flags.password;
      const data = await api.adminRequest(ctx, 'POST', '/wrappers/servers', { body });
      output(ctx, data, (_d, ui) => ui.success(`Created foreign server ${name}`));
    },
  },
  'drop-server': {
    summary: 'Drop a foreign server',
    usage: 'motherbase wrappers drop-server <name>',
    async run(ctx, args) {
      const name = requireArg(args[0], 'name');
      const data = await api.adminRequest(ctx, 'DELETE', `/wrappers/servers/${enc(name)}`);
      output(ctx, data, (_d, ui) => ui.success(`Dropped foreign server ${name}`));
    },
  },
  credentials: {
    summary: 'Replace the remote credentials of a foreign server',
    usage: 'motherbase wrappers credentials <server> --user <u> --password <p>',
    async run(ctx, args, flags) {
      const name = requireArg(args[0], 'server');
      if (typeof flags.user !== 'string' || typeof flags.password !== 'string') {
        throw new CliError('--user and --password are required');
      }
      const body = { user: flags.user, password: flags.password };
      const data = await api.adminRequest(ctx, 'PUT', `/wrappers/servers/${enc(name)}/credentials`, { body });
      output(ctx, data, (_d, ui) => ui.success(`Updated credentials of ${name}`));
    },
  },
  import: {
    summary: 'Import a remote schema as foreign tables',
    usage:
      'motherbase wrappers import <server> --remote-schema <s> --local-schema <s> [--tables a,b]',
    async run(ctx, args, flags) {
      const name = requireArg(args[0], 'server');
      const body = {
        remoteSchema: requireArg(flags['remote-schema'], '--remote-schema'),
        localSchema: requireArg(flags['local-schema'], '--local-schema'),
      };
      if (typeof flags.tables === 'string') body.tables = flags.tables.split(',').map(t => t.trim()).filter(Boolean);
      const data = await api.adminRequest(ctx, 'POST', `/wrappers/servers/${enc(name)}/import`, { body });
      output(ctx, data, (_d, ui) => ui.success(`Imported ${body.remoteSchema} into ${body.localSchema}`));
    },
  },
  'create-table': {
    summary: 'Create one foreign table',
    usage:
      'motherbase wrappers create-table <schema>.<table> --server <s> --column <name>:<type> ... [--option k=v ...]',
    async run(ctx, args, flags) {
      const [schema, name] = qualified(args[0]);
      const body = {
        server: requireArg(flags.server, '--server'),
        schema,
        name,
        columns: columns(flags),
        options: options(flags),
      };
      const data = await api.adminRequest(ctx, 'POST', '/wrappers/tables', { body });
      output(ctx, data, (_d, ui) => ui.success(`Created foreign table ${schema}.${name}`));
    },
  },
  'drop-table': {
    summary: 'Drop a foreign table',
    usage: 'motherbase wrappers drop-table <schema>.<table>',
    async run(ctx, args) {
      const [schema, name] = qualified(args[0]);
      const data = await api.adminRequest(ctx, 'DELETE', `/wrappers/tables/${enc(schema)}/${enc(name)}`);
      output(ctx, data, (_d, ui) => ui.success(`Dropped foreign table ${schema}.${name}`));
    },
  },
};

module.exports = {
  summary: 'Foreign data wrappers (postgres_fdw, file_fdw)',
  usage: 'motherbase wrappers <list|enable|create-server|drop-server|credentials|import|create-table|drop-table> ...',
  subcommands,
};
