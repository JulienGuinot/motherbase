'use strict';

// Project API keys. `secrets` next door is a different thing: those are values
// an edge function reads, these are what a client presents to reach the project.

const api = require('../api');
const { output, requireArg } = require('./_util');

const TYPES = ['publishable', 'secret'];

const subcommands = {
  list: {
    summary: 'List project API keys',
    usage: 'motherbase keys list',
    async run(ctx) {
      const data = await api.adminRequest(ctx, 'GET', '/api-keys');
      const keys = (data && data.keys) || [];
      output(ctx, data, (_d, ui) =>
        ui.table(
          keys.map(k => ({
            name: k.name,
            type: k.type,
            // A secret key has no stored clear value; the prefix is all there is.
            key: k.token || `${k.prefix}…`,
            status: k.revokedAt ? 'revoked' : 'active',
          })),
          [
            { key: 'name', label: 'NAME' },
            { key: 'type', label: 'TYPE' },
            { key: 'key', label: 'KEY' },
            { key: 'status', label: 'STATUS' },
          ],
        ),
      );
    },
  },
  create: {
    summary: 'Create a key. A secret key is printed once and never again',
    usage: 'motherbase keys create <NAME> [--type publishable|secret]',
    async run(ctx, args, flags) {
      const name = requireArg(args[0], 'NAME');
      const type = flags.type || 'secret';
      if (!TYPES.includes(type)) {
        throw new Error(`--type must be one of: ${TYPES.join(', ')}`);
      }
      const data = await api.adminRequest(ctx, 'POST', '/api-keys', { body: { name, type } });
      output(ctx, data, (d, ui) => {
        ui.success(`Created ${type} key "${name}"`);
        ui.print(d.clearToken);
        if (type === 'secret') {
          ui.warn('Copy it now. It is stored hashed and cannot be shown again.');
          ui.warn('It bypasses row level security: keep it server side.');
        }
      });
    },
  },
  revoke: {
    summary: 'Revoke a key by id',
    usage: 'motherbase keys revoke <ID>',
    async run(ctx, args) {
      const id = requireArg(args[0], 'ID');
      const data = await api.adminRequest(ctx, 'DELETE', `/api-keys/${encodeURIComponent(id)}`);
      output(ctx, data, (d, ui) => ui.success(`Revoked key ${d.name || id}`));
    },
  },
};

module.exports = {
  summary: 'Project API keys (publishable and secret)',
  usage: 'motherbase keys <list|create|revoke> ...',
  subcommands,
};
