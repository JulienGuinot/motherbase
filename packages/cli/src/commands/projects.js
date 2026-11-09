'use strict';

const api = require('../api');
const keys = require('./keys');
const { output, alias, requireArg } = require('./_util');
const { CliError } = require('../context');
const { outputFormat } = require('../format');

const LIFECYCLE = ['start', 'stop', 'restart', 'update', 'rebuild'];

function lifecycleCmd(action) {
  return {
    summary: `${action} a project`,
    usage: `motherbase projects ${action} <id>`,
    async run(ctx, args) {
      const id = requireArg(args[0], 'id');
      const data = await api.consoleRequest(ctx, 'POST', `/projects/${id}/${action}`);
      output(ctx, data, (d, ui) => ui.success(`${action} → ${id}`));
    },
  };
}

const subcommands = {
  list: {
    summary: 'List all projects on the console',
    usage: 'motherbase projects list',
    async run(ctx) {
      const data = await api.consoleRequest(ctx, 'GET', '/projects');
      output(ctx, data, (rows, ui) =>
        ui.table(Array.isArray(rows) ? rows : [], [
          { key: 'name', label: 'NAME' },
          { key: 'status', label: 'STATUS' },
          { key: 'domain', label: 'DOMAIN' },
        ]),
      );
    },
  },
  create: {
    summary: 'Create a new project',
    usage: 'motherbase projects create <name> [--domain <domain>]',
    async run(ctx, args, flags) {
      const name = requireArg(args[0], 'name');
      const body = { name };
      if (flags.domain) body.domain = flags.domain;
      const data = await api.consoleRequest(ctx, 'POST', '/projects', { body });
      output(ctx, data, (d, ui) => ui.success(`Created project ${name}`));
    },
  },
  delete: {
    summary: 'Delete a project (requires --confirm <name>)',
    usage: 'motherbase projects delete <id> --confirm <name>',
    async run(ctx, args, flags) {
      const id = requireArg(args[0], 'id');
      const confirm = flags.confirm;
      if (confirm !== id) {
        throw new CliError(`Refusing to delete. Pass --confirm ${id} to proceed.`);
      }
      const data = await api.consoleRequest(ctx, 'DELETE', `/projects/${id}`, { body: { confirm } });
      output(ctx, data, (d, ui) => ui.success(`Deleted project ${id}`));
    },
  },
  logs: {
    summary: 'Show recent logs for a project',
    usage: 'motherbase projects logs <id> [-f]',
    async run(ctx, args, flags) {
      const id = requireArg(args[0], 'id');
      const fetchOnce = () => api.consoleRequest(ctx, 'GET', `/projects/${id}/logs`);
      const data = await fetchOnce();
      output(ctx, data, (d, ui) => {
        if (d && d.stdout) ui.print(d.stdout);
        if (d && d.stderr) ui.printErr(d.stderr);
      });
      if (flags.f && outputFormat(ctx.flags) === 'pretty') {
        // The console logs endpoint returns a snapshot; approximate -f by polling.
        const ui = require('../ui');
        ui.warn('(-f) polling every 3s; Ctrl-C to stop');
        setInterval(async () => {
          try {
            const next = await fetchOnce();
            if (next && next.stdout) process.stdout.write(next.stdout);
          } catch (e) { ui.warn(e.message); }
        }, 3000);
        await new Promise(() => {});
      }
    },
  },
  info: {
    summary: 'Show project details and DNS checks',
    usage: 'motherbase projects info <id>',
    async run(ctx, args) {
      const id = requireArg(args[0], 'id');
      const list = await api.consoleRequest(ctx, 'GET', '/projects');
      const project = (Array.isArray(list) ? list : []).find(p => p.name === id || p.id === id) || { name: id };
      let dns = null;
      try { dns = await api.consoleRequest(ctx, 'GET', `/projects/${id}/dns`); } catch { /* optional */ }
      const data = { ...project, dns: dns && dns.checks };
      output(ctx, data, (d, ui) => ui.keyValue(d));
    },
  },
  limits: {
    summary: 'Get or set per-project resource limits',
    usage: 'motherbase projects limits <id> [--api-cpus n --api-mem mb --db-cpus n --db-mem mb --minio-cpus n --minio-mem mb --edge-cpus n --edge-mem mb]',
    async run(ctx, args, flags) {
      const id = requireArg(args[0], 'id');
      const map = {
        'api-cpus': 'apiCpus', 'api-mem': 'apiMemMb',
        'db-cpus': 'dbCpus', 'db-mem': 'dbMemMb',
        'minio-cpus': 'minioCpus', 'minio-mem': 'minioMemMb',
        'edge-cpus': 'edgeCpus', 'edge-mem': 'edgeMemMb',
      };
      const body = {};
      for (const [flag, key] of Object.entries(map)) {
        if (flags[flag] !== undefined) body[key] = Number(flags[flag]);
      }
      const method = Object.keys(body).length ? 'PATCH' : 'GET';
      const data = await api.consoleRequest(ctx, method, `/projects/${id}/limits`, method === 'PATCH' ? { body } : {});
      output(ctx, data, (d, ui) => ui.keyValue(d || {}));
    },
  },
};

for (const action of LIFECYCLE) subcommands[action] = lifecycleCmd(action);

// Supabase's `projects api-keys`; the keys themselves live under `keys`.
subcommands['api-keys'] = alias(keys.subcommands.list, 'motherbase projects api-keys [--project-ref <id>]');

module.exports = {
  summary: 'Manage projects on the Platform Console',
  usage: 'motherbase projects <list|create|start|stop|restart|update|rebuild|delete|logs|info|limits|api-keys> ...',
  subcommands,
};
