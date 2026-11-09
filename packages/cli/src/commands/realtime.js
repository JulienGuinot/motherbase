'use strict';

const api = require('../api');
const { output } = require('./_util');

const subcommands = {
  config: {
    summary: 'Show realtime config, or set enabled models with --models a,b,c',
    usage: 'motherbase realtime config [--models a,b,c]',
    async run(ctx, args, flags) {
      if (flags.models !== undefined) {
        const models = String(flags.models).split(',').map(s => s.trim()).filter(Boolean);
        const data = await api.adminRequest(ctx, 'PATCH', '/realtime/config', { body: { models } });
        output(ctx, data, (d, ui) => ui.success(`Enabled models: ${(d && d.models ? d.models : models).join(', ') || '(none)'}`));
        return;
      }
      const data = await api.adminRequest(ctx, 'GET', '/realtime/config');
      output(ctx, data, (d, ui) => ui.keyValue(d || {}));
    },
  },
  channels: {
    summary: 'List active realtime channels',
    usage: 'motherbase realtime channels',
    async run(ctx) {
      const data = await api.adminRequest(ctx, 'GET', '/realtime/channels');
      output(ctx, data, (d, ui) => ui.json((d && d.channels) || d));
    },
  },
};

module.exports = {
  summary: 'Realtime configuration and channels',
  usage: 'motherbase realtime <config|channels> ...',
  subcommands,
};
