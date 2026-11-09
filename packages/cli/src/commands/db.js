'use strict';

const fs = require('fs');
const path = require('path');
const api = require('../api');
const prompt = require('../prompt');
const rls = require('./rls');
const { output, alias, parseKeyValues } = require('./_util');
const { CliError } = require('../context');

const subcommands = {
  tables: {
    summary: 'List database tables',
    usage: 'motherbase db tables',
    async run(ctx) {
      const data = await api.adminRequest(ctx, 'GET', '/schema/tables');
      const tables = (data && data.tables) || data || [];
      output(ctx, data, (_d, ui) =>
        ui.table(Array.isArray(tables) ? tables : [], [
          { key: 'name', label: 'TABLE' },
          { key: 'schema', label: 'SCHEMA' },
        ]),
      );
    },
  },
  sql: {
    summary: 'Run SQL from -e "..." or a file',
    usage: 'motherbase db sql -e "select 1" | motherbase db sql <file.sql>',
    async run(ctx, args, flags) {
      let sql = flags.e || flags.execute;
      if (!sql && args[0]) sql = fs.readFileSync(path.resolve(ctx.cwd, args[0]), 'utf8');
      if (!sql) throw new CliError('Provide SQL via -e "..." or a file path.');
      const data = await api.adminRequest(ctx, 'POST', '/sql', { body: { sql } });
      output(ctx, data, (d, ui) => {
        if (d && Array.isArray(d.rows)) ui.table(d.rows);
        else if (Array.isArray(d)) ui.table(d);
        else ui.json(d);
      });
    },
  },
  // `db dump` is Supabase's local dump (../migration/commands); this is the
  // server-side backup it used to be.
  backup: {
    summary: 'Create a database backup on the server',
    usage: 'motherbase db backup [file]',
    async run(ctx, args) {
      const body = args[0] ? { file: args[0] } : {};
      const data = await api.adminRequest(ctx, 'POST', '/backups', { body });
      output(ctx, data, (d, ui) => ui.success(`Backup created${d && d.file ? `: ${d.file}` : ''}`));
    },
  },
  restore: {
    summary: 'Restore the database from a server dump or offsite key',
    usage: 'motherbase db restore <file> | --key <remoteKey>  --confirm',
    async run(ctx, args, flags) {
      const file = args[0];
      const key = flags.key;
      if (!file && !key) throw new CliError('Provide a <file> or --key <remoteKey>.');
      if (!flags.confirm && !flags.yes) {
        const ok = await prompt.confirm('This will overwrite the database. Continue?');
        if (!ok) throw new CliError('Aborted.');
      }
      const body = key ? { key, confirm: 'RESTORE' } : { file, confirm: 'RESTORE' };
      const data = await api.adminRequest(ctx, 'POST', '/backups/restore', { body });
      output(ctx, data, (d, ui) => ui.success('Restore complete'));
    },
  },
  backups: {
    summary: 'List backups, or manage backup config (`db backups config`)',
    usage: 'motherbase db backups [list] | motherbase db backups config [--set key=value ...]',
    async run(ctx, args, flags) {
      const sub = args[0];
      if (sub === 'config') {
        const sets = [].concat(flags.set || []).filter(Boolean);
        if (sets.length) {
          const body = parseKeyValues(sets);
          const data = await api.adminRequest(ctx, 'PUT', '/backups/config', { body });
          output(ctx, data, (d, ui) => ui.success('Backup config saved'));
        } else {
          const data = await api.adminRequest(ctx, 'GET', '/backups/config');
          output(ctx, data, (d, ui) => ui.keyValue(d || {}));
        }
        return;
      }
      const data = await api.adminRequest(ctx, 'GET', '/backups/list');
      output(ctx, data, (d, ui) => ui.json(d));
    },
  },
};

// Supabase's local-files workflow: push, pull, diff, reset, dump, seed.
Object.assign(subcommands, require('../migration/commands').dbSubcommands);
// Studio's Database section: indexes, enum types, roles, column privileges, publications.
Object.assign(subcommands, require('./db-catalog'));

// Supabase's `db lint`: the same advisor as `rls lint`.
subcommands.lint = alias(rls.subcommands.lint, 'motherbase db lint [--level critical|warning|info]');

module.exports = {
  summary: 'Database: tables, SQL, dumps, restores, indexes, types, roles, publications',
  usage: 'motherbase db <push|pull|diff|reset|dump|seed|tables|sql|backup|restore|backups|lint|indexes|types|roles|column-privileges|publications> ...',
  subcommands,
};
