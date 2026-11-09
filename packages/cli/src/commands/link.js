'use strict';

const api = require('../api');
const config = require('../config');
const prompt = require('../prompt');
const ui = require('../ui');
const { CliError } = require('../context');

module.exports = {
  summary: 'Link the current directory to a project (writes ./.motherbase/config.json)',
  usage: 'motherbase link [projectNameOrId]',
  async run(ctx, args, flags) {
    const { consoleUrl } = ctx.requireConsole();
    const projects = await api.consoleRequest(ctx, 'GET', '/projects');
    const list = Array.isArray(projects) ? projects : [];
    if (list.length === 0) throw new CliError('No projects available on this console.');

    let picked = args[0];
    if (!picked) {
      if (flags.yes) throw new CliError('Specify a project name/id when using --yes.');
      ui.print(ui.color.bold('Available projects:'));
      list.forEach((p, i) => ui.print(`  ${i + 1}. ${p.name || p.id}`));
      const answer = await prompt.question('Pick a project (number or name): ');
      const asNum = Number(answer);
      picked = Number.isInteger(asNum) && list[asNum - 1] ? (list[asNum - 1].name || list[asNum - 1].id) : answer;
    }

    const match = list.find(p => p.name === picked || p.id === picked);
    if (!match) throw new CliError(`Project "${picked}" not found on ${consoleUrl}.`);

    const projectId = match.name || match.id;
    config.writeLink(ctx.cwd, { consoleUrl, projectId, projectName: match.name || projectId });
    ui.success(`Linked ${ctx.cwd} → ${projectId} (${consoleUrl})`);
  },
};
