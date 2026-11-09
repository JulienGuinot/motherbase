'use strict';

const fs = require('fs');
const path = require('path');
const api = require('../api');
const { output, requireArg, parseKeyValues, parseDotenv } = require('./_util');
const { CliError } = require('../context');

// `NAME=VALUE ...` plus `--env-file`, as the Supabase CLI takes them. The older
// `set NAME value` form keeps working. Positional pairs win over the file.
// Node itself pre-scans argv for `--env-file` and exits (code 9) when the path
// does not exist relative to the shell's cwd, before this code runs; with
// `--workdir`, pass an absolute path.
function collectSecrets(cwd, args, flags) {
  const fromFile = flags['env-file']
    ? parseDotenv(fs.readFileSync(path.resolve(cwd, String(flags['env-file'])), 'utf8'))
    : {};
  const legacy = args.length === 2 && !args[0].includes('=');
  const fromArgs = legacy ? { [args[0]]: args[1] } : parseKeyValues(args, { coerce: false });
  return { ...fromFile, ...fromArgs };
}

const subcommands = {
  list: {
    summary: 'List edge secrets (names only)',
    usage: 'motherbase secrets list',
    async run(ctx) {
      const data = await api.adminRequest(ctx, 'GET', '/edge-secrets');
      const secrets = (data && data.secrets) || data || [];
      output(ctx, data, (_d, ui) =>
        ui.table((Array.isArray(secrets) ? secrets : []).map(s => (typeof s === 'string' ? { name: s } : s)), [
          { key: 'name', label: 'NAME' },
        ]),
      );
    },
  },
  set: {
    summary: 'Set one or more secrets',
    usage: 'motherbase secrets set NAME=VALUE [NAME=VALUE ...] [--env-file .env]',
    async run(ctx, args, flags) {
      const secrets = collectSecrets(ctx.cwd, args, flags);
      const names = Object.keys(secrets);
      if (!names.length) throw new CliError('Nothing to set. Pass NAME=VALUE pairs or --env-file <path>.');
      // The server sets one secret per request.
      for (const name of names) {
        await api.adminRequest(ctx, 'PUT', '/edge-secrets', { body: { name, value: secrets[name] } });
      }
      output(ctx, { set: names }, (d, ui) => ui.success(`Set ${names.length === 1 ? 'secret' : 'secrets'} ${names.join(', ')}`));
    },
  },
  unset: {
    summary: 'Remove a secret',
    usage: 'motherbase secrets unset <NAME>',
    async run(ctx, args) {
      const name = requireArg(args[0], 'NAME');
      const data = await api.adminRequest(ctx, 'DELETE', `/edge-secrets/${encodeURIComponent(name)}`);
      output(ctx, data, (d, ui) => ui.success(`Removed secret ${name}`));
    },
  },
};

module.exports = {
  summary: 'Edge function secrets',
  usage: 'motherbase secrets <list|set|unset> ...',
  subcommands,
};
