'use strict';

const api = require('../api');
const { output, requireArg } = require('./_util');
const { CliError } = require('../context');

const subcommands = {
  list: {
    summary: 'List Vault secrets (names and metadata, never values)',
    usage: 'motherbase vault list',
    async run(ctx) {
      const data = await api.adminRequest(ctx, 'GET', '/vault');
      const secrets = (data && data.secrets) || [];
      output(ctx, data, (_d, ui) =>
        ui.table(secrets, [
          { key: 'id', label: 'ID' },
          { key: 'name', label: 'NAME' },
          { key: 'description', label: 'DESCRIPTION' },
          { key: 'updatedAt', label: 'UPDATED' },
        ]),
      );
    },
  },
  enable: {
    summary: 'Install the Vault for this project',
    usage: 'motherbase vault enable',
    async run(ctx) {
      const data = await api.adminRequest(ctx, 'POST', '/vault/enable');
      output(ctx, data, (_d, ui) => ui.success('Vault enabled'));
    },
  },
  create: {
    summary: 'Store an encrypted secret',
    usage: 'motherbase vault create <name> --secret <value> [--description <text>]',
    async run(ctx, args, flags) {
      const name = requireArg(args[0], 'name');
      if (typeof flags.secret !== 'string') throw new CliError('--secret is required');
      const body = { name, secret: flags.secret };
      if (typeof flags.description === 'string') body.description = flags.description;
      const data = await api.adminRequest(ctx, 'POST', '/vault/secrets', { body });
      output(ctx, data, (_d, ui) => ui.success(`Created secret ${name}`));
    },
  },
  update: {
    summary: 'Rename a secret, change its value or its description',
    usage: 'motherbase vault update <id> [--name <n>] [--secret <value>] [--description <text>]',
    async run(ctx, args, flags) {
      const id = requireArg(args[0], 'id');
      const body = {};
      for (const key of ['name', 'secret', 'description']) {
        if (typeof flags[key] === 'string') body[key] = flags[key];
      }
      if (!Object.keys(body).length) throw new CliError('nothing to update: pass --name, --secret or --description');
      const data = await api.adminRequest(ctx, 'PATCH', `/vault/secrets/${encodeURIComponent(id)}`, { body });
      output(ctx, data, (_d, ui) => ui.success(`Updated secret ${id}`));
    },
  },
  reveal: {
    summary: 'Print the decrypted value of a secret',
    usage: 'motherbase vault reveal <id>',
    async run(ctx, args) {
      const id = requireArg(args[0], 'id');
      const data = await api.adminRequest(ctx, 'GET', `/vault/secrets/${encodeURIComponent(id)}/reveal`);
      output(ctx, data, (d, ui) => ui.print(String((d && d.secret) ?? '')));
    },
  },
  delete: {
    summary: 'Delete a secret',
    usage: 'motherbase vault delete <id>',
    async run(ctx, args) {
      const id = requireArg(args[0], 'id');
      const data = await api.adminRequest(ctx, 'DELETE', `/vault/secrets/${encodeURIComponent(id)}`);
      output(ctx, data, (_d, ui) => ui.success(`Deleted secret ${id}`));
    },
  },
};

module.exports = {
  summary: 'Encrypted secrets (Vault)',
  usage: 'motherbase vault <list|enable|create|update|reveal|delete> ...',
  subcommands,
};
