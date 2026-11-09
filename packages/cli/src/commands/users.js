'use strict';

const api = require('../api');
const { output, requireArg } = require('./_util');
const { CliError } = require('../context');

// Collect known user fields from flags into a body.
function userBody(flags) {
  const body = {};
  for (const key of ['email', 'password', 'name', 'role']) {
    if (flags[key] !== undefined) body[key] = flags[key];
  }
  return body;
}

const subcommands = {
  list: {
    summary: 'List project users',
    usage: 'motherbase users list',
    async run(ctx) {
      const data = await api.adminRequest(ctx, 'GET', '/users');
      const users = (data && data.users) || data || [];
      output(ctx, data, (_d, ui) =>
        ui.table(Array.isArray(users) ? users : [], [
          { key: 'id', label: 'ID' },
          { key: 'email', label: 'EMAIL' },
          { key: 'role', label: 'ROLE' },
        ]),
      );
    },
  },
  get: {
    summary: 'Get a user by id',
    usage: 'motherbase users get <id>',
    async run(ctx, args) {
      const id = requireArg(args[0], 'id');
      const data = await api.adminRequest(ctx, 'GET', `/users/${id}`);
      output(ctx, data, (d, ui) => ui.keyValue(d || {}));
    },
  },
  create: {
    summary: 'Create a user',
    usage: 'motherbase users create --email <e> --password <p> [--name <n>] [--role <r>]',
    async run(ctx, args, flags) {
      const body = userBody(flags);
      if (!body.email || !body.password) throw new CliError('--email and --password are required');
      const data = await api.adminRequest(ctx, 'POST', '/users', { body });
      output(ctx, data, (d, ui) => ui.success(`Created user ${body.email}`));
    },
  },
  update: {
    summary: 'Update a user',
    usage: 'motherbase users update <id> [--email ...] [--name ...] [--role ...]',
    async run(ctx, args, flags) {
      const id = requireArg(args[0], 'id');
      const body = userBody(flags);
      const data = await api.adminRequest(ctx, 'PATCH', `/users/${id}`, { body });
      output(ctx, data, (d, ui) => ui.success(`Updated user ${id}`));
    },
  },
  delete: {
    summary: 'Delete a user',
    usage: 'motherbase users delete <id>',
    async run(ctx, args) {
      const id = requireArg(args[0], 'id');
      const data = await api.adminRequest(ctx, 'DELETE', `/users/${id}`);
      output(ctx, data, (d, ui) => ui.success(`Deleted user ${id}`));
    },
  },
  'reset-password': {
    summary: 'Reset a user password',
    usage: 'motherbase users reset-password <id> [--password <p>]',
    async run(ctx, args, flags) {
      const id = requireArg(args[0], 'id');
      const body = typeof flags.password === 'string' ? { password: flags.password } : {};
      const data = await api.adminRequest(ctx, 'POST', `/users/${id}/reset-password`, { body });
      output(ctx, data, (d, ui) => ui.success(`Password reset for ${id}`));
    },
  },
  promote: {
    summary: 'Promote a user to ADMIN',
    usage: 'motherbase users promote <id>',
    async run(ctx, args) {
      const id = requireArg(args[0], 'id');
      const data = await api.adminRequest(ctx, 'POST', `/users/${id}/promote`);
      output(ctx, data, (d, ui) => ui.success(`Promoted ${id}`));
    },
  },
  demote: {
    summary: 'Demote a user to USER',
    usage: 'motherbase users demote <id>',
    async run(ctx, args) {
      const id = requireArg(args[0], 'id');
      const data = await api.adminRequest(ctx, 'POST', `/users/${id}/demote`);
      output(ctx, data, (d, ui) => ui.success(`Demoted ${id}`));
    },
  },
  'revoke-sessions': {
    summary: 'Revoke all sessions for a user',
    usage: 'motherbase users revoke-sessions <id>',
    async run(ctx, args) {
      const id = requireArg(args[0], 'id');
      const data = await api.adminRequest(ctx, 'POST', `/users/${id}/revoke-sessions`);
      output(ctx, data, (d, ui) => ui.success(`Sessions revoked for ${id}`));
    },
  },


  deactivate: {
    summary: 'Deactivate a user account and revoke its sessions',
    usage: 'motherbase users deactivate <id>',
    async run(ctx, args) {
      const id = requireArg(args[0], 'id');
      const data = await api.adminRequest(ctx, 'PATCH', `/users/${id}`, { body: { status: 'deleted' } });
      output(ctx, data, (_d, ui) => ui.success(`Deactivated user ${id}`));
    },
  },

  impersonate: {
    summary: 'Grants a token to impersonate a user by id',
    usage: 'motherbase users impersonate <id>',
    async run(ctx, args) {
      const id = requireArg(args[0], 'id');
      const data = await api.adminRequest(ctx, 'POST', `/users/${id}/impersonate`);
      const session = { accessToken: data.token, user: data.user };
      const cookie = `motherbase.session=${encodeURIComponent(JSON.stringify(session))}; path=/; expires=${new Date(data.expiresAt).toUTCString()}; SameSite=Lax`;
      const command = `document.cookie=${JSON.stringify(cookie)}; location.reload()`;

      output(ctx, data, (_d, ui) =>
        ui.success(`Paste this in your browser console to impersonate ${data.user.username ?? data.user.email}: ${command}`),
      );
    },
  },

  audit: {
    summary: 'Read the auth audit log, newest first',
    usage: 'motherbase users audit [--action <a>] [--actor <email|id>] [--type <log type>] [--from <iso>] [--to <iso>] [--limit <n>]',
    async run(ctx, args, flags) {
      const query = {
        action: flags.action,
        actor: flags.actor,
        log_type: flags.type,
        from: flags.from,
        to: flags.to,
        per_page: flags.limit || 50,
      };
      const data = await api.adminRequest(ctx, 'GET', '/auth/audit-logs', { query });
      const entries = ((data && data.entries) || []).map(e => ({
        at: e.created_at,
        action: e.payload.action,
        actor: e.payload.actor_username || e.payload.actor_id,
        ip: e.ip_address,
      }));
      output(ctx, data, (_d, ui) =>
        ui.table(entries, [
          { key: 'at', label: 'AT' },
          { key: 'action', label: 'ACTION' },
          { key: 'actor', label: 'ACTOR' },
          { key: 'ip', label: 'IP' },
        ]),
      );
    },
  },
};

module.exports = {
  summary: 'Project auth users',
  usage: 'motherbase users <list|get|create|update|delete|reset-password|promote|demote|revoke-sessions|deactivate|impersonate|audit> ...',
  subcommands,
};
