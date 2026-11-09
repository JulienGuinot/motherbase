'use strict';

const api = require('../api');
const { output, requireArg, parseKeyValues } = require('./_util');

const subcommands = {
  list: {
    summary: 'List setting groups',
    usage: 'motherbase config list',
    async run(ctx) {
      const data = await api.adminRequest(ctx, 'GET', '/settings');
      const groups = (data && data.groups) || [];
      output(ctx, data, (_d, ui) =>
        ui.table(groups, [
          { key: 'key', label: 'GROUP' },
          { key: 'label', label: 'LABEL' },
          { key: 'source', label: 'SOURCE' },
        ]),
      );
    },
  },
  get: {
    summary: 'Get a settings group',
    usage: 'motherbase config get <group>',
    async run(ctx, args) {
      const group = requireArg(args[0], 'group');
      const data = await api.adminRequest(ctx, 'GET', `/settings/${group}`);
      output(ctx, data, (d, ui) => ui.keyValue(d || {}));
    },
  },
  set: {
    summary: 'Set values in a settings group',
    usage: 'motherbase config set <group> key=value [key2=value2 ...]',
    async run(ctx, args) {
      const group = requireArg(args[0], 'group');
      const body = parseKeyValues(args.slice(1));
      const data = await api.adminRequest(ctx, 'PUT', `/settings/${group}`, { body });
      output(ctx, data, (d, ui) => ui.success(`Saved settings for ${group}`));
    },
  },
};

module.exports = {
  summary: 'Project settings groups',
  usage: 'motherbase config <list|get|set> ...',
  subcommands,
};
