'use strict';

const api = require('../api');
const prompt = require('../prompt');
const { output } = require('./_util');
const { CliError } = require('../context');

// Sections beyond the database need their own credential, because that is where
// Supabase keeps them: object bytes behind the Storage API (service_role key),
// edge functions and project secrets behind the Management API (a personal
// access token). Both are optional; without one, that section reports what it
// could not read instead of failing the import.
module.exports = {
  summary: 'Import a Supabase project (schema, data, auth, storage, edge functions, secrets)',
  usage:
    'motherbase import --from-supabase <connectionString> [--service-role-key <key>] [--management-token <sbp_…>] ' +
    '[--preview] [--no-data] [--no-auth] [--no-storage] [--no-edge-functions] [--no-secrets]',
  async run(ctx, args, flags) {
    const connectionString = flags['from-supabase'] || flags.fromSupabase;
    if (!connectionString) throw new CliError('--from-supabase <connectionString> is required');

    const include = {
      schema: true,
      data: !flags['no-data'],
      auth: !flags['no-auth'],
      storage: !flags['no-storage'],
      edgeFunctions: !flags['no-edge-functions'],
      secrets: !flags['no-secrets'],
    };
    const preview = Boolean(flags.preview);

    const body = { connectionString, include };
    const serviceRoleKey = flags['service-role-key'] || flags.serviceRoleKey;
    const managementToken = flags['management-token'] || flags.managementToken;
    if (serviceRoleKey) body.serviceRoleKey = serviceRoleKey;
    if (managementToken) body.managementToken = managementToken;
    if (flags['project-ref'] || flags.projectRef) body.projectRef = flags['project-ref'] || flags.projectRef;

    if (preview) {
      body.preview = true;
    } else {
      if (!flags.yes) {
        const ok = await prompt.confirm('This will import into the linked project. Continue?');
        if (!ok) throw new CliError('Aborted.');
      }
      body.confirm = 'IMPORT';
    }

    const data = await api.adminRequest(ctx, 'POST', '/import/supabase', { body });
    output(ctx, data, (d, ui) => {
      if (preview) { ui.info('Import preview (dry run):'); ui.json(d); }
      else { ui.success('Import complete'); ui.json(d); }
    });
  },
};
