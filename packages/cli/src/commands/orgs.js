'use strict';

// Tenant organizations on the Platform Console. Projects sit under an org, as
// they do on Supabase.

const api = require('../api');
const { output, requireArg } = require('./_util');

const subcommands = {
  list: {
    summary: 'List the organizations you belong to',
    usage: 'motherbase orgs list',
    async run(ctx) {
      const data = await api.consoleRequest(ctx, 'GET', '/orgs');
      output(ctx, data, (rows, ui) =>
        ui.table(Array.isArray(rows) ? rows : [], [
          { key: 'id', label: 'ID' },
          { key: 'name', label: 'NAME' },
          { key: 'role', label: 'ROLE' },
          { key: 'projectCount', label: 'PROJECTS' },
        ]),
      );
    },
  },
  create: {
    summary: 'Create an organization',
    usage: 'motherbase orgs create <name>',
    async run(ctx, args) {
      const name = requireArg(args[0], 'name');
      const data = await api.consoleRequest(ctx, 'POST', '/orgs', { body: { name } });
      output(ctx, data, (d, ui) => ui.success(`Created org ${d.name} (${d.id})`));
    },
  },
};

module.exports = {
  summary: 'Manage organizations on the Platform Console',
  usage: 'motherbase orgs <list|create> ...',
  subcommands,
};
