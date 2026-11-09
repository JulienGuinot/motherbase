'use strict';

// Resolve the runtime context: which console, which token, which project, and
// whether we talk through the Console proxy ('console' mode) or straight at a
// single project API ('direct' mode). Precedence everywhere: flags > env > config.
//
// Resolution is LAZY: building a context never throws, so commands that need no
// project (login, local docker, init) work with zero configuration. The
// require*() helpers throw a clear, actionable error only when a value is
// actually needed and missing.

const config = require('./config');

class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliError';
    this.isCliError = true;
  }
}

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}

function createContext(flags = {}, env = process.env, cwd = process.cwd()) {
  const link = config.readLink(cwd) || {};
  const global = config.readGlobal();

  const consoleUrl = firstDefined(
    flags.url,
    env.MOTHERBASE_CONSOLE_URL,
    link.consoleUrl,
    global.current,
  );
  const normConsoleUrl = consoleUrl ? config.normalizeUrl(consoleUrl) : undefined;

  // The link file is committed to the repo, so a URL that came only from it is
  // not trusted with a token the user supplied for some other console.
  const urlFromLinkOnly = !firstDefined(flags.url, env.MOTHERBASE_CONSOLE_URL) && Boolean(link.consoleUrl);

  const token = firstDefined(
    urlFromLinkOnly ? undefined : flags.token,
    urlFromLinkOnly ? undefined : env.MOTHERBASE_TOKEN,
    normConsoleUrl ? (config.consoleEntry(normConsoleUrl) || {}).token : undefined,
  );

  const projectId = firstDefined(flags.project, env.MOTHERBASE_PROJECT, link.projectId);
  const projectName = firstDefined(link.projectName, projectId);

  // Direct project mode: an admin JWT pointed straight at one project API. Only
  // used as a fallback when there is no console link/flags to route through.
  const directUrl = env.MOTHERBASE_URL ? config.normalizeUrl(env.MOTHERBASE_URL) : undefined;
  const directToken = env.MOTHERBASE_ADMIN_TOKEN;
  const hasConsole = Boolean(normConsoleUrl && token);
  const hasProjectLink = Boolean(projectId);
  const preferDirect = Boolean(directUrl && directToken) && !(hasConsole && hasProjectLink);
  const mode = preferDirect ? 'direct' : 'console';

  return {
    flags,
    env,
    cwd,
    mode,
    consoleUrl: normConsoleUrl,
    token,
    projectId,
    projectName,
    directUrl,
    directToken,
    linkedConsoleUrl: link.consoleUrl,
    accountEmail: normConsoleUrl ? (config.consoleEntry(normConsoleUrl) || {}).email : undefined,

    // Console (account / multi-project) requests need URL + session token.
    requireConsole() {
      if (!this.consoleUrl) {
        throw new CliError('No console URL. Run `motherbase login --url <consoleUrl>` or set MOTHERBASE_CONSOLE_URL.');
      }
      if (!this.token) {
        throw new CliError('Not logged in. Run `motherbase login` or set MOTHERBASE_TOKEN.');
      }
      return { consoleUrl: this.consoleUrl, token: this.token };
    },

    // Admin/resource requests: resolve either the console proxy path or a direct
    // project API, whichever the context selected.
    requireProject() {
      if (this.mode === 'direct') {
        return { mode: 'direct', baseUrl: this.directUrl, token: this.directToken };
      }
      this.requireConsole();
      if (!this.projectId) {
        throw new CliError('No project linked. Run `motherbase link` or set MOTHERBASE_PROJECT (or use direct mode via MOTHERBASE_URL + MOTHERBASE_ADMIN_TOKEN).');
      }
      return {
        mode: 'console',
        consoleUrl: this.consoleUrl,
        token: this.token,
        projectId: this.projectId,
      };
    },
  };
}

module.exports = { createContext, CliError };
