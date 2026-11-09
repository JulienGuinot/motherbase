'use strict';

// `motherbase postgres-config get|update|delete`, Supabase's command of the
// same name. The one difference is where a value lands: the server picks the
// narrowest scope Postgres allows (a per-database override for
// `statement_timeout`, ALTER SYSTEM for `shared_buffers`), and `--scope`
// overrides that. Motherbase never restarts Postgres itself, so `--no-restart`
// is accepted for script compatibility and a restart-only change is reported.

const api = require('../api');
const { output, parseKeyValues } = require('./_util');
const { CliError } = require('../context');

const SCOPES = ['database', 'role', 'system'];

function scopeFlags(flags) {
  if (flags.scope !== undefined && !SCOPES.includes(flags.scope)) {
    throw new CliError(`--scope must be one of: ${SCOPES.join(', ')}`);
  }
  if (flags.scope === 'role' && !flags.role) throw new CliError('--scope role needs --role <name>');
  return {
    ...(flags.scope ? { scope: flags.scope } : {}),
    ...(flags.role ? { role: String(flags.role) } : {}),
  };
}

// What `get` prints: one row per setting that has an override, like Supabase,
// or every curated setting with --all.
function overrideRows(config, all) {
  return config.settings.flatMap(setting => {
    if (!setting.overrides.length) {
      return all ? [{ name: setting.name, value: setting.value, scope: '', role: '', restart: setting.context === 'postmaster' }] : [];
    }
    return setting.overrides.map(o => ({
      name: setting.name,
      value: o.value,
      scope: o.scope,
      role: o.role || '',
      restart: setting.context === 'postmaster',
    }));
  });
}

function reportChange(result, ui) {
  for (const change of result.applied) {
    ui.success(`${change.name}: ${change.scope}${change.role ? ` (${change.role})` : ''}`);
  }
  if (result.restartRequired.length) {
    ui.warn(`Restart Postgres to apply: ${result.restartRequired.join(', ')}`);
  }
}

const subcommands = {
  get: {
    summary: 'Show Postgres config overrides (--all for every managed setting)',
    usage: 'motherbase postgres-config get [--all]',
    async run(ctx, args, flags) {
      const data = await api.adminRequest(ctx, 'GET', '/database/config');
      output(ctx, data, (d, ui) => {
        ui.table(overrideRows(d, Boolean(flags.all)), [
          { key: 'name', label: 'PARAMETER' },
          { key: 'value', label: 'VALUE' },
          { key: 'scope', label: 'SCOPE' },
          { key: 'role', label: 'ROLE' },
          { key: 'restart', label: 'NEEDS RESTART' },
        ]);
        if (!d.systemOverridesReadable) ui.warn('System-level overrides could not be read with this connection.');
      });
    },
  },
  update: {
    summary: 'Set Postgres config values',
    usage: 'motherbase postgres-config update --config key=value [--config ...] [--scope database|role|system] [--role r] [--replace-existing-overrides]',
    async run(ctx, args, flags) {
      const values = parseKeyValues([].concat(flags.config || []).filter(Boolean), { coerce: false });
      if (!Object.keys(values).length) throw new CliError('Provide at least one --config key=value.');
      const target = scopeFlags(flags);
      const changes = Object.entries(values).map(([name, value]) => ({ name, value, ...target }));

      // Supabase's flag: anything overridden before and not named now goes back to its default.
      if (flags['replace-existing-overrides']) {
        const current = await api.adminRequest(ctx, 'GET', '/database/config');
        for (const setting of current.settings) {
          if (setting.name in values) continue;
          for (const o of setting.overrides) {
            changes.push({ name: setting.name, value: null, scope: o.scope, ...(o.role ? { role: o.role } : {}) });
          }
        }
      }

      const data = await api.adminRequest(ctx, 'PATCH', '/database/config', { body: { changes } });
      output(ctx, data, (d, ui) => reportChange(d, ui));
    },
  },
  delete: {
    summary: 'Remove Postgres config overrides, restoring the defaults',
    usage: 'motherbase postgres-config delete --config key1,key2 [--scope database|role|system] [--role r]',
    async run(ctx, args, flags) {
      const names = [].concat(flags.config || []).flatMap(v => String(v).split(',')).map(s => s.trim()).filter(Boolean);
      if (!names.length) throw new CliError('Provide the settings to reset with --config key1,key2.');
      const target = scopeFlags(flags);
      const changes = names.map(name => ({ name, value: null, ...target }));
      const data = await api.adminRequest(ctx, 'PATCH', '/database/config', { body: { changes } });
      output(ctx, data, (d, ui) => reportChange(d, ui));
    },
  },
};

module.exports = {
  summary: 'Postgres configuration (statement_timeout, work_mem, max_connections, ...)',
  usage: 'motherbase postgres-config <get|update|delete> ...',
  subcommands,
};
