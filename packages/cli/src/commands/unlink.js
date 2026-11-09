'use strict';

const config = require('../config');
const ui = require('../ui');
const { CliError } = require('../context');

module.exports = {
  summary: 'Remove the project link from the current directory',
  usage: 'motherbase unlink',
  async run(ctx) {
    const removed = config.removeLink(ctx.cwd);
    if (!removed) throw new CliError('No project link found in this directory.');
    ui.success('Unlinked project.');
  },
};
