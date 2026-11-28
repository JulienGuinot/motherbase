'use strict';

const api = require('../api');
const { output, requireArg } = require('./_util');
const { CliError } = require('../context');

const subcommands = {
  list: {
    summary: 'List webhooks',
    usage: 'motherbase webhooks list',
    async run(ctx) {
      const data = await api.adminRequest(ctx, 'GET', '/webhooks');
      const rows = (data && data.webhooks) || data || [];
      output(ctx, data, (_d, ui) =>
        ui.table(Array.isArray(rows) ? rows : [], [
          { key: 'id', label: 'ID' },
          { key: 'name', label: 'NAME' },
          { key: 'url', label: 'URL' },
          { key: 'events', label: 'EVENTS' },
        ]),
      );
    },
  },
  create: {
    summary: 'Create a webhook',
    usage: 'motherbase webhooks create --name <n> --url <u> --events a,b',
    async run(ctx, args, flags) {
      if (!flags.name || !flags.url || !flags.events) throw new CliError('--name, --url and --events are required');
      const body = {
        name: flags.name,
        url: flags.url,
        events: String(flags.events).split(',').map(s => s.trim()).filter(Boolean),
      };
      const data = await api.adminRequest(ctx, 'POST', '/webhooks', { body });
      output(ctx, data, (d, ui) => ui.success(`Created webhook ${flags.name}`));
    },
  },
  delete: {
    summary: 'Delete a webhook',
    usage: 'motherbase webhooks delete <id>',
    async run(ctx, args) {
      const id = requireArg(args[0], 'id');
      const data = await api.adminRequest(ctx, 'DELETE', `/webhooks/${id}`);
      output(ctx, data, (d, ui) => ui.success(`Deleted webhook ${id}`));
    },
  },
  'rotate-secret': {
    summary: 'Replace a webhook signing secret (the old one stops verifying at once)',
    usage: 'motherbase webhooks rotate-secret <id>',
    async run(ctx, args) {
      const id = requireArg(args[0], 'id');
      const data = await api.adminRequest(ctx, 'POST', `/webhooks/${id}/rotate-secret`);
      output(ctx, data, (d, ui) => ui.success(`New signing secret for ${id}: ${d && d.secret}`));
    },
  },
  test: {
    summary: 'Send a test event to a webhook',
    usage: 'motherbase webhooks test <id>',
    async run(ctx, args) {
      const id = requireArg(args[0], 'id');
      const data = await api.adminRequest(ctx, 'POST', `/webhooks/${id}/test`);
      output(ctx, data, (d, ui) => ui.json(d));
    },
  },
};

module.exports = {
  summary: 'Outgoing webhooks',
  usage: 'motherbase webhooks <list|create|delete|rotate-secret|test> ...',
  subcommands,
};
