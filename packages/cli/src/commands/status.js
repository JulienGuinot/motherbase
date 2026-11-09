'use strict';

const api = require('../api');
const { output } = require('./_util');

module.exports = {
  summary: 'Show connection status: console, link, and a project health probe',
  usage: 'motherbase status',
  async run(ctx) {
    const data = {
      console: ctx.consoleUrl || null,
      loggedIn: Boolean(ctx.token),
      mode: ctx.mode,
      project: ctx.projectId || null,
      reachable: null,
      api: null,
    };

    if (ctx.projectId || ctx.mode === 'direct') {
      try {
        const info = await api.adminRequest(ctx, 'GET', '/connect-info');
        data.reachable = true;
        data.api = info && info.apiUrl;
      } catch (err) {
        data.reachable = false;
        data.error = err.message;
      }
    }

    output(ctx, data, (d, ui) => {
      ui.keyValue({
        Console: d.console || '(none)',
        'Logged in': d.loggedIn ? 'yes' : 'no',
        Mode: d.mode,
        Project: d.project || '(not linked)',
        Reachable: d.reachable === null ? 'n/a' : d.reachable ? 'yes' : 'no',
        'API URL': d.api || '',
      });
      if (d.error) ui.warn(d.error);
    });
  },
};
