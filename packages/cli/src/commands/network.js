'use strict';

// Who may open a direct Postgres connection (Supabase's `network-restrictions`
// and `ssl-enforcement`). Both are project admin routes, so they work through
// the Console proxy and in direct mode alike.

const api = require('../api');
const { output } = require('./_util');
const { CliError } = require('../context');

function renderRestrictions(d, ui) {
  ui.keyValue({
    'IPv4 allowed': d.dbAllowedCidrs.join(', ') || '(none)',
    'IPv6 allowed': d.dbAllowedCidrsV6.join(', ') || '(none)',
    status: d.status,
    exposure: d.exposure,
  });
  if (d.status !== 'applied') ui.warn('Stored only: this API does not manage its database access (not a Console stack).');
  if (d.exposure !== 'public') ui.info('The database port is not public, so only the stack and SSH tunnels reach it today.');
}

const networkRestrictions = {
  summary: 'IP ranges allowed to connect to the database directly',
  usage: 'motherbase network-restrictions <get|update> ...',
  subcommands: {
    get: {
      summary: 'Show the allowed ranges',
      usage: 'motherbase network-restrictions get',
      async run(ctx) {
        output(ctx, await api.adminRequest(ctx, 'GET', '/network-restrictions'), renderRestrictions);
      },
    },
    update: {
      summary: 'Replace the allowed ranges (repeat --db-allow-cidr; IPv4 and IPv6 are told apart)',
      usage: 'motherbase network-restrictions update --db-allow-cidr <cidr> [--db-allow-cidr <cidr> ...]',
      async run(ctx, _args, flags) {
        const cidrs = [].concat(flags['db-allow-cidr'] ?? []).map(String);
        if (!cidrs.length) {
          throw new CliError('Pass at least one --db-allow-cidr (0.0.0.0/0 and ::/0 allow everyone).');
        }
        const body = {
          dbAllowedCidrs: cidrs.filter(c => !c.includes(':')),
          dbAllowedCidrsV6: cidrs.filter(c => c.includes(':')),
        };
        output(ctx, await api.adminRequest(ctx, 'PUT', '/network-restrictions', { body }), renderRestrictions);
      },
    },
  },
};

function renderSsl(d, ui) {
  ui.keyValue({ enforced: d.enforced, 'TLS active': d.sslActive, status: d.status });
  if (d.enforced) ui.info('External clients must connect with sslmode=require.');
}

const sslEnforcement = {
  summary: 'Require TLS for direct database connections',
  usage: 'motherbase ssl-enforcement <get|update> ...',
  subcommands: {
    get: {
      summary: 'Show whether TLS is enforced',
      usage: 'motherbase ssl-enforcement get',
      async run(ctx) {
        output(ctx, await api.adminRequest(ctx, 'GET', '/ssl-enforcement'), renderSsl);
      },
    },
    update: {
      summary: 'Turn enforcement on or off',
      usage: 'motherbase ssl-enforcement update --enable-db-ssl-enforcement | --disable-db-ssl-enforcement',
      async run(ctx, _args, flags) {
        const enable = Boolean(flags['enable-db-ssl-enforcement']);
        const disable = Boolean(flags['disable-db-ssl-enforcement']);
        if (enable === disable) {
          throw new CliError('Pass exactly one of --enable-db-ssl-enforcement or --disable-db-ssl-enforcement.');
        }
        const data = await api.adminRequest(ctx, 'PUT', '/ssl-enforcement', { body: { enforced: enable } });
        output(ctx, data, renderSsl);
      },
    },
  },
};

module.exports = { networkRestrictions, sslEnforcement };
