'use strict';

const api = require('../api');
const { output, requireArg } = require('./_util');
const { CliError } = require('../context');

const enc = encodeURIComponent;

function int(flag, name) {
  if (flag === undefined) return undefined;
  const n = Number(flag);
  if (!Number.isInteger(n) || n < 0) throw new CliError(`--${name} must be a non-negative integer`);
  return n;
}

function parseMessage(raw) {
  try {
    return JSON.parse(requireArg(raw, 'json'));
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError('the message must be valid JSON, e.g. \'{"task":"resize"}\'');
  }
}

const subcommands = {
  list: {
    summary: 'List queues with their depth',
    usage: 'motherbase queues list',
    async run(ctx) {
      const data = await api.adminRequest(ctx, 'GET', '/queues');
      const queues = (data && data.queues) || [];
      output(ctx, data, (_d, ui) =>
        ui.table(queues, [
          { key: 'name', label: 'NAME' },
          { key: 'type', label: 'TYPE' },
          { key: 'length', label: 'MESSAGES' },
          { key: 'visibleLength', label: 'VISIBLE' },
          { key: 'totalMessages', label: 'TOTAL' },
        ]),
      );
    },
  },
  enable: {
    summary: 'Install pgmq for this project',
    usage: 'motherbase queues enable',
    async run(ctx) {
      const data = await api.adminRequest(ctx, 'POST', '/queues/enable');
      output(ctx, data, (_d, ui) => ui.success('Queues enabled'));
    },
  },
  expose: {
    summary: 'Expose queues to the client SDK through pgmq_public (or hide them)',
    usage: 'motherbase queues expose <true|false>',
    async run(ctx, args) {
      const value = requireArg(args[0], 'true|false');
      if (value !== 'true' && value !== 'false') throw new CliError('expected true or false');
      const data = await api.adminRequest(ctx, 'PUT', '/queues/expose', { body: { enabled: value === 'true' } });
      output(ctx, data, (_d, ui) => ui.success(`Queues ${value === 'true' ? 'exposed' : 'hidden'}`));
    },
  },
  create: {
    summary: 'Create a queue',
    usage: 'motherbase queues create <name> [--type basic|unlogged|partitioned] [--rls true|false]',
    async run(ctx, args, flags) {
      const name = requireArg(args[0], 'name');
      const body = { name };
      if (flags.type) body.type = flags.type;
      if (flags.rls !== undefined) body.rls = flags.rls === true || flags.rls === 'true';
      const data = await api.adminRequest(ctx, 'POST', '/queues', { body });
      output(ctx, data, (_d, ui) => ui.success(`Created queue ${name}`));
    },
  },
  drop: {
    summary: 'Drop a queue and its messages',
    usage: 'motherbase queues drop <name>',
    async run(ctx, args) {
      const name = requireArg(args[0], 'name');
      const data = await api.adminRequest(ctx, 'DELETE', `/queues/${enc(name)}`);
      output(ctx, data, (_d, ui) => ui.success(`Dropped queue ${name}`));
    },
  },
  send: {
    summary: 'Send a JSON message',
    usage: "motherbase queues send <name> '<json>' [--delay seconds]",
    async run(ctx, args, flags) {
      const name = requireArg(args[0], 'name');
      const body = { message: parseMessage(args[1]) };
      const delay = int(flags.delay, 'delay');
      if (delay !== undefined) body.delay = delay;
      const data = await api.adminRequest(ctx, 'POST', `/queues/${enc(name)}/messages`, { body });
      output(ctx, data, (d, ui) => ui.success(`Sent message ${((d && d.msgIds) || []).join(', ')}`));
    },
  },
  read: {
    summary: 'Read messages, hiding them from other readers for the visibility timeout',
    usage: 'motherbase queues read <name> [--qty 1] [--vt 30]',
    async run(ctx, args, flags) {
      const name = requireArg(args[0], 'name');
      const body = {};
      const qty = int(flags.qty, 'qty');
      const vt = int(flags.vt, 'vt');
      if (qty !== undefined) body.qty = qty;
      if (vt !== undefined) body.vt = vt;
      const data = await api.adminRequest(ctx, 'POST', `/queues/${enc(name)}/read`, { body });
      output(ctx, data, (d, ui) => ui.json((d && d.messages) || []));
    },
  },
  archive: {
    summary: 'Move a message to the archive',
    usage: 'motherbase queues archive <name> <msg-id>',
    async run(ctx, args) {
      const name = requireArg(args[0], 'name');
      const id = requireArg(args[1], 'msg-id');
      const data = await api.adminRequest(ctx, 'POST', `/queues/${enc(name)}/messages/${enc(id)}/archive`);
      output(ctx, data, (_d, ui) => ui.success(`Archived message ${id}`));
    },
  },
  purge: {
    summary: 'Delete every message in a queue',
    usage: 'motherbase queues purge <name>',
    async run(ctx, args) {
      const name = requireArg(args[0], 'name');
      const data = await api.adminRequest(ctx, 'POST', `/queues/${enc(name)}/purge`);
      output(ctx, data, (d, ui) => ui.success(`Purged ${(d && d.purged) ?? 0} messages from ${name}`));
    },
  },
};

module.exports = {
  summary: 'Message queues (pgmq)',
  usage: 'motherbase queues <list|enable|expose|create|drop|send|read|archive|purge> ...',
  subcommands,
};
