'use strict';

const api = require('../api');
const { output } = require('./_util');

module.exports = {
  summary: 'Show the current console, account and platform info',
  usage: 'motherbase whoami',
  async run(ctx) {
    const { consoleUrl } = ctx.requireConsole();
    const info = await api.consoleRequest(ctx, 'GET', '/info');
    const data = {
      console: consoleUrl,
      email: ctx.accountEmail || null,
      mode: info && info.mode,
      domainSuffix: info && info.domainSuffix,
    };
    output(ctx, data, (d, ui) => ui.keyValue(d));
  },
};
