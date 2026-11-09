'use strict';

const config = require('../config');
const ui = require('../ui');
const { CliError } = require('../context');

module.exports = {
  summary: 'Remove the stored token for the current (or --url) console',
  usage: 'motherbase logout [--url <consoleUrl>]',
  async run(ctx) {
    const url = config.normalizeUrl(ctx.flags.url || ctx.consoleUrl || '');
    if (!url) throw new CliError('No console to log out of.');
    config.clearConsoleToken(url);
    ui.success(`Logged out of ${url}`);
  },
};
