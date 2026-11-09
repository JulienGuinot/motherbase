'use strict';

// Custom domains and vanity subdomains (Supabase's `supabase domains` and
// `supabase vanity-subdomains`). Both are Console routes on the linked project.

const api = require('../api');
const { output, requireArg, consoleProjectPath } = require('./_util');

function renderHostname(d, ui) {
  const custom = d.customHostname;
  if (!custom) {
    ui.info(`No custom domain. The API answers on ${d.projectDomain}.`);
    return;
  }
  ui.keyValue({ hostname: custom.hostname, status: custom.status, projectDomain: d.projectDomain });
  if (custom.status !== 'active') {
    ui.print('');
    ui.print('Publish these DNS records, then run `motherbase domains reverify`:');
    ui.table(custom.requiredRecords, [
      { key: 'type', label: 'TYPE' },
      { key: 'name', label: 'NAME' },
      { key: 'value', label: 'VALUE' },
    ]);
  }
  for (const check of custom.checks || []) {
    ui[check.ok ? 'success' : 'warn'](`${check.record} ${check.name}: ${check.ok ? 'ok' : `found ${check.found.join(', ') || 'nothing'}`}`);
  }
}

const hostnamePath = (ctx, suffix = '') => consoleProjectPath(ctx, `/custom-hostname${suffix}`);

const domains = {
  summary: 'Custom domain for the linked project\'s API',
  usage: 'motherbase domains <create|get|reverify|activate|delete> ...',
  subcommands: {
    create: {
      summary: 'Start using a custom hostname (prints the DNS records to publish)',
      usage: 'motherbase domains create --custom-hostname <api.example.com>',
      async run(ctx, _args, flags) {
        const hostname = requireArg(flags['custom-hostname'], 'custom-hostname');
        const data = await api.consoleRequest(ctx, 'POST', hostnamePath(ctx), { body: { hostname } });
        output(ctx, data, renderHostname);
      },
    },
    get: {
      summary: 'Show the custom hostname and its verification state',
      usage: 'motherbase domains get',
      async run(ctx) {
        output(ctx, await api.consoleRequest(ctx, 'GET', hostnamePath(ctx)), renderHostname);
      },
    },
    reverify: {
      summary: 'Check the DNS records again',
      usage: 'motherbase domains reverify',
      async run(ctx) {
        output(ctx, await api.consoleRequest(ctx, 'POST', hostnamePath(ctx, '/reverify')), renderHostname);
      },
    },
    activate: {
      summary: 'Serve the API on the verified hostname (TLS is issued on first request)',
      usage: 'motherbase domains activate',
      async run(ctx) {
        output(ctx, await api.consoleRequest(ctx, 'POST', hostnamePath(ctx, '/activate')), renderHostname);
      },
    },
    delete: {
      summary: 'Stop using the custom hostname',
      usage: 'motherbase domains delete',
      async run(ctx) {
        const data = await api.consoleRequest(ctx, 'DELETE', hostnamePath(ctx));
        output(ctx, data, (_d, ui) => ui.success('Custom hostname removed'));
      },
    },
  },
};

function renderVanity(d, ui) {
  if (d.vanitySubdomain) ui.keyValue(d.vanitySubdomain);
  else ui.info(`No vanity subdomain${d.vanitySuffix ? ` (they live under ${d.vanitySuffix})` : ''}.`);
}

const vanityPath = (ctx, suffix = '') => consoleProjectPath(ctx, `/vanity-subdomain${suffix}`);

const vanitySubdomains = {
  summary: 'Vanity subdomain under the platform domain',
  usage: 'motherbase vanity-subdomains <get|check-availability|activate|delete> ...',
  subcommands: {
    get: {
      summary: 'Show the active vanity subdomain',
      usage: 'motherbase vanity-subdomains get',
      async run(ctx) {
        output(ctx, await api.consoleRequest(ctx, 'GET', vanityPath(ctx)), renderVanity);
      },
    },
    'check-availability': {
      summary: 'Is a subdomain free?',
      usage: 'motherbase vanity-subdomains check-availability --desired-subdomain <name>',
      async run(ctx, _args, flags) {
        const subdomain = requireArg(flags['desired-subdomain'], 'desired-subdomain');
        const data = await api.consoleRequest(ctx, 'POST', vanityPath(ctx, '/check-availability'), { body: { subdomain } });
        output(ctx, data, (d, ui) => (d.available ? ui.success(`${d.hostname} is available`) : ui.warn(`${d.hostname} is taken`)));
      },
    },
    activate: {
      summary: 'Serve the API on <name>.<platform domain> as well',
      usage: 'motherbase vanity-subdomains activate --desired-subdomain <name>',
      async run(ctx, _args, flags) {
        const subdomain = requireArg(flags['desired-subdomain'], 'desired-subdomain');
        const data = await api.consoleRequest(ctx, 'POST', vanityPath(ctx), { body: { subdomain } });
        output(ctx, data, renderVanity);
      },
    },
    delete: {
      summary: 'Remove the vanity subdomain',
      usage: 'motherbase vanity-subdomains delete',
      async run(ctx) {
        const data = await api.consoleRequest(ctx, 'DELETE', vanityPath(ctx));
        output(ctx, data, (_d, ui) => ui.success('Vanity subdomain removed'));
      },
    },
  },
};

module.exports = { domains, vanitySubdomains };
