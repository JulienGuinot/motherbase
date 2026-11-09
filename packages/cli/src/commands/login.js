'use strict';

const api = require('../api');
const config = require('../config');
const prompt = require('../prompt');
const ui = require('../ui');
const { CliError } = require('../context');

module.exports = {
  summary: 'Log in to a Motherbase Console (email/password → session token)',
  usage: 'motherbase login [--url <consoleUrl>] [--email <email>] [--code <totp>]',
  async run(ctx, args, flags) {
    const consoleUrl = config.normalizeUrl(
      flags.url || ctx.env.MOTHERBASE_CONSOLE_URL || ctx.consoleUrl || '',
    );
    if (!consoleUrl) {
      throw new CliError('Console URL required. Use --url <consoleUrl> or set MOTHERBASE_CONSOLE_URL.');
    }

    // Non-interactive: accept a token directly (CI).
    if (flags.token) {
      const email = flags.email || 'token';
      config.saveConsoleToken(consoleUrl, flags.token, email);
      ui.success(`Stored token for ${consoleUrl}`);
      return;
    }


    const email = flags.email || (await prompt.question('Email: '));
    if (!email) throw new CliError('email is required');
    const password = (typeof flags.password === 'string' && flags.password) || (await prompt.password('Password: '));
    if (!password) throw new CliError('password is required');

    let data = await api.loginRequest(consoleUrl, email, password);
    if (data.twoFactorCookie) {
      const code = (typeof flags.code === 'string' && flags.code) || (await prompt.question('Authenticator code: '));
      if (!code) throw new CliError('two-factor code is required');
      data = await api.verifyTotpRequest(consoleUrl, data.twoFactorCookie, code);
    }
    const token = data.token;
    if (!token) throw new CliError('login succeeded but no token was returned');
    config.saveConsoleToken(consoleUrl, token, email);
    ui.success(`Logged in to ${consoleUrl} as ${email}`);
  },
};
