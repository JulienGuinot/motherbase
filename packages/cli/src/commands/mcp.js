'use strict';

// `motherbase mcp`: expose the linked project, and the console's organizations
// and projects, to an AI agent over the Model Context Protocol.
//
// The transport is stdio, which is how an MCP client launches a server: it spawns
// this process and talks JSON-RPC over its stdin/stdout. Nothing is printed to
// stdout except protocol messages, so diagnostics go to stderr.

const { serve, toolServer } = require('../mcp/protocol');
const { buildTools } = require('../mcp/tools');
const { CliError } = require('../context');

const pkg = require('../../package.json');

/** Whether a `require*()` resolves, without surfacing its error. */
function reaches(resolve) {
  try {
    resolve();
    return true;
  } catch {
    return false;
  }
}

const mcp = {
  summary: 'Serve the linked project and console to an AI agent over MCP (stdio)',
  usage: 'motherbase mcp [--write]',
  async run(ctx, _args, flags = {}) {
    // Resolve what this session reaches up front. Failing here is a clear CLI
    // error; failing on the first tool call is an opaque one inside someone's agent.
    const scope = { project: reaches(() => ctx.requireProject()), console: reaches(() => ctx.requireConsole()) };
    if (!scope.project && !scope.console) {
      throw new CliError(
        'Nothing to serve. Run `motherbase login` for the organization and project tools, and `motherbase link` '
          + '(or set MOTHERBASE_URL + MOTHERBASE_ADMIN_TOKEN) for the database tools.',
      );
    }

    const write = Boolean(flags.write);
    const tools = buildTools(ctx, { write, ...scope });

    process.stderr.write(
      `motherbase mcp: ${tools.length} tools, ${write ? 'read and write' : 'read only'}. `
        + `Project: ${scope.project ? ctx.projectName || ctx.projectId || 'direct' : 'none linked'}. `
        + `Console: ${scope.console ? ctx.consoleUrl : 'not logged in'}\n`,
    );
    if (!write) {
      process.stderr.write('  Pass --write to expose apply_migration, raw SQL writes, function deploys and project lifecycle.\n');
    }

    await serve({
      input: process.stdin,
      output: process.stdout,
      handlers: toolServer({ name: 'motherbase', version: pkg.version, tools }),
      onError: err => process.stderr.write(`motherbase mcp: ${err && err.message ? err.message : err}\n`),
    });
  },
};

module.exports = mcp;
