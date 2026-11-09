'use strict';

// `migration`: Supabase's name for the group. The server-side lifecycle
// (list/diff/get/create/apply/rollback) and the local `new` scaffold live
// together here; `migrations` is registered as an alias of this entry.

const fs = require('fs');
const path = require('path');
const api = require('../api');
const ui = require('../ui');
const { output, requireArg } = require('./_util');
const { CliError } = require('../context');

function readSql(cwd, file) {
  if (!file) return undefined;
  return fs.readFileSync(path.resolve(cwd, file), 'utf8');
}

const subcommands = {
  new: {
    summary: 'Scaffold a local migration .sql file',
    usage: 'motherbase migration new <name>',
    async run(ctx, args) {
      const name = requireArg(args[0], 'name');
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new CliError('name must be alphanumeric / dash / underscore');
      const dir = path.join(ctx.cwd, 'motherbase', 'migrations');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '');
      const file = path.join(dir, `${stamp}_${name}.sql`);
      fs.writeFileSync(file, `-- Migration: ${name}\n\n\n-- @down\n-- Optional: SQL that undoes the above, for \`migration down\`.\n`, { flag: 'wx' });
      ui.success(`Created ${path.relative(ctx.cwd, file)}`);
    },
  },
  list: {
    summary: 'List schema migrations',
    usage: 'motherbase migration list',
    async run(ctx) {
      const data = await api.adminRequest(ctx, 'GET', '/migrations');
      const rows = (data && data.migrations) || [];
      output(ctx, data, (_d, ui) =>
        ui.table(rows, [
          { key: 'id', label: 'ID' },
          { key: 'name', label: 'NAME' },
          { key: 'status', label: 'STATUS' },
          { key: 'appliedAt', label: 'APPLIED' },
        ]),
      );
    },
  },
  diff: {
    summary: 'Show a diff between live schema and migrations',
    usage: 'motherbase migration diff',
    async run(ctx) {
      const data = await api.adminRequest(ctx, 'GET', '/migrations/diff');
      output(ctx, data, (d, ui) => ui.json(d));
    },
  },
  get: {
    summary: 'Show a single migration',
    usage: 'motherbase migration get <id>',
    async run(ctx, args) {
      const id = requireArg(args[0], 'id');
      const data = await api.adminRequest(ctx, 'GET', `/migrations/${id}`);
      output(ctx, data, (d, ui) => ui.keyValue((d && d.migration) || d || {}));
    },
  },
  create: {
    summary: 'Create a migration from up/down SQL files',
    usage: 'motherbase migration create --name <name> --up <file.sql> [--down <file.sql>]',
    async run(ctx, args, flags) {
      const name = flags.name || args[0];
      if (!name) throw new CliError('--name is required');
      const upSql = readSql(ctx.cwd, flags.up);
      const downSql = readSql(ctx.cwd, flags.down);
      if (!upSql) throw new CliError('--up <file.sql> is required');
      const data = await api.adminRequest(ctx, 'POST', '/migrations', { body: { name, upSql, downSql } });
      output(ctx, data, (d, ui) => ui.success(`Created migration ${name}`));
    },
  },
  apply: {
    summary: 'Apply a migration',
    usage: 'motherbase migration apply <id>',
    async run(ctx, args) {
      const id = requireArg(args[0], 'id');
      const data = await api.adminRequest(ctx, 'POST', `/migrations/${id}/apply`);
      output(ctx, data, (d, ui) => ui.success(`Applied ${id}`));
    },
  },
  rollback: {
    summary: 'Roll back a migration',
    usage: 'motherbase migration rollback <id>',
    async run(ctx, args) {
      const id = requireArg(args[0], 'id');
      const data = await api.adminRequest(ctx, 'POST', `/migrations/${id}/rollback`);
      output(ctx, data, (d, ui) => ui.success(`Rolled back ${id}`));
    },
  },
};

// The local-files workflow (list/up/down/repair/squash/fetch) lives with its
// helpers in ../migration.
Object.assign(subcommands, require('../migration/commands').migrationSubcommands);

module.exports = {
  summary: 'Schema migrations: local files and the remote history',
  usage: 'motherbase migration <new|list|up|down|repair|squash|fetch|diff|get|create|apply|rollback> ...',
  subcommands,
};
