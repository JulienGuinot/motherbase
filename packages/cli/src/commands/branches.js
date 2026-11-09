'use strict';

// Preview branches (Supabase's `supabase branches`). A branch is a project of
// its own on the Console, cut from the linked project; these commands address
// it by its name (e.g. the git branch) or its project id.

const api = require('../api');
const config = require('../config');
const { output, requireArg, consoleProjectPath } = require('./_util');

const COLUMNS = [
  { key: 'name', label: 'NAME' },
  { key: 'project', label: 'PROJECT' },
  { key: 'gitBranch', label: 'GIT BRANCH' },
  { key: 'status', label: 'STATUS' },
  { key: 'running', label: 'RUNNING' },
  { key: 'createdAt', label: 'CREATED' },
];

const branchPath = (ctx, name, action = '') =>
  consoleProjectPath(ctx, `/branches/${encodeURIComponent(requireArg(name, 'name'))}${action}`);

function action(verb, summary, render) {
  return {
    summary,
    usage: `motherbase branches ${verb} <name>`,
    async run(ctx, args) {
      const data = await api.consoleRequest(ctx, 'POST', branchPath(ctx, args[0], `/${verb}`));
      output(ctx, data, (d, ui) => render(d, ui));
    },
  };
}

const subcommands = {
  create: {
    summary: 'Create a preview branch of the linked project',
    usage: 'motherbase branches create <name> [--git-branch <ref>] [--with-data]',
    async run(ctx, args, flags) {
      const body = { name: requireArg(args[0], 'name'), withData: Boolean(flags['with-data']) };
      if (flags['git-branch']) body.gitBranch = String(flags['git-branch']);
      const data = await api.consoleRequest(ctx, 'POST', consoleProjectPath(ctx, '/branches'), { body });
      output(ctx, data, (d, ui) => {
        ui.success(`Creating branch ${d.name} as project ${d.project} (${d.domain})`);
        ui.info('This takes a few minutes. Follow it with `motherbase branches get ' + d.name + '`.');
      });
    },
  },
  list: {
    summary: 'List the branches of the linked project, main first',
    usage: 'motherbase branches list',
    async run(ctx) {
      const rows = await api.consoleRequest(ctx, 'GET', consoleProjectPath(ctx, '/branches'));
      output(ctx, { branches: rows }, (d, ui) => ui.table(d.branches, COLUMNS));
    },
  },
  get: {
    summary: 'Show one branch, with the migrations it is ahead and behind',
    usage: 'motherbase branches get <name>',
    async run(ctx, args) {
      const data = await api.consoleRequest(ctx, 'GET', branchPath(ctx, args[0]));
      output(ctx, data, (d, ui) => {
        const { migrations, ...rest } = d;
        ui.keyValue(rest);
        if (migrations) ui.keyValue({ ahead: migrations.ahead.join(', ') || '-', behind: migrations.behind.join(', ') || '-' });
      });
    },
  },
  update: {
    summary: 'Change a branch\'s git branch',
    usage: 'motherbase branches update <name> --git-branch <ref>',
    async run(ctx, args, flags) {
      const body = {};
      if (flags['git-branch'] !== undefined) body.gitBranch = String(flags['git-branch']);
      const data = await api.consoleRequest(ctx, 'PATCH', branchPath(ctx, args[0]), { body });
      output(ctx, data, (d, ui) => ui.success(`Updated branch ${d.name}`));
    },
  },
  delete: {
    summary: 'Delete a branch and its whole stack',
    usage: 'motherbase branches delete <name>',
    async run(ctx, args) {
      const data = await api.consoleRequest(ctx, 'DELETE', branchPath(ctx, args[0]));
      output(ctx, data, (d, ui) => ui.success(`Deleted branch ${d.name}`));
    },
  },
  pause: action('pause', 'Stop a branch\'s stack, keeping its data', (d, ui) => ui.success(`Paused ${d.name}`)),
  unpause: action('unpause', 'Start a paused branch again', (d, ui) => ui.success(`Unpaused ${d.name}`)),
  reset: action('reset', 'Recreate a branch from the parent as it is now (its changes are lost)',
    (d, ui) => ui.success(`Resetting ${d.name}; it is being cut again from ${d.parent}`)),
  merge: action('merge', 'Apply the branch\'s new migrations to the parent',
    (d, ui) => ui.success(d.applied.length ? `Merged ${d.applied.length} migration(s): ${d.applied.join(', ')}` : 'Nothing to merge')),
  rebase: action('rebase', 'Apply the parent\'s newer migrations to the branch',
    (d, ui) => ui.success(d.applied.length ? `Rebased ${d.applied.length} migration(s): ${d.applied.join(', ')}` : 'Already up to date')),
  switch: {
    summary: 'Point this directory\'s link at a branch (or back at main)',
    usage: 'motherbase branches switch <name|main>',
    async run(ctx, args) {
      const name = requireArg(args[0], 'name');
      const rows = await api.consoleRequest(ctx, 'GET', consoleProjectPath(ctx, '/branches'));
      const match = rows.find(b => b.name === name || b.project === name || (name === 'main' && b.isDefault));
      if (!match) throw new Error(`No branch ${name}. See \`motherbase branches list\`.`);
      const link = config.readLink(ctx.cwd) || {};
      config.writeLink(ctx.cwd, { ...link, consoleUrl: ctx.consoleUrl, projectId: match.project, projectName: match.project });
      output(ctx, { project: match.project, branch: match.name }, (d, ui) => ui.success(`Linked ${ctx.cwd} → ${d.project} (${d.branch})`));
    },
  },
};

module.exports = {
  summary: 'Manage preview branches of the linked project',
  usage: 'motherbase branches <create|list|get|update|delete|pause|unpause|reset|merge|rebase|switch> ...',
  subcommands,
};
