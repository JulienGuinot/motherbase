'use strict';

const api = require('../api');
const { output, requireArg } = require('./_util');
const { CliError } = require('../context');

const policy = {
  summary: 'Manage RLS policies',
  usage: 'motherbase rls policy create --table <t> --name <n> --command <SELECT|INSERT|UPDATE|DELETE|ALL> [--using <expr>] [--check <expr>] [--roles a,b] | motherbase rls policy delete <table> <name>',
  subcommands: {
    create: {
      summary: 'Create an RLS policy',
      usage: 'motherbase rls policy create --table <t> --name <n> --command <cmd> [--using <expr>] [--check <expr>] [--roles a,b]',
      async run(ctx, args, flags) {
        const body = {
          table: flags.table,
          name: flags.name,
          command: (flags.command || 'ALL').toUpperCase(),
        };
        if (!body.table || !body.name) throw new CliError('--table and --name are required');
        if (flags.using) body.using = flags.using;
        if (flags.check) body.check = flags.check;
        if (flags.roles) body.roles = String(flags.roles).split(',').map(s => s.trim()).filter(Boolean);
        const data = await api.adminRequest(ctx, 'POST', '/rls/policies', { body });
        output(ctx, data, (d, ui) => ui.success(`Created policy ${body.name} on ${body.table}`));
      },
    },
    delete: {
      summary: 'Delete an RLS policy',
      usage: 'motherbase rls policy delete <table> <name>',
      async run(ctx, args) {
        const table = requireArg(args[0], 'table');
        const name = requireArg(args[1], 'name');
        const data = await api.adminRequest(ctx, 'DELETE', '/rls/policies', { body: { table, name } });
        output(ctx, data, (d, ui) => ui.success(`Dropped policy ${name} on ${table}`));
      },
    },
  },
};

const subcommands = {
  list: {
    summary: 'List tables with RLS status and policies',
    usage: 'motherbase rls list',
    async run(ctx) {
      const data = await api.adminRequest(ctx, 'GET', '/rls/tables');
      output(ctx, data, (rows, ui) =>
        ui.table((Array.isArray(rows) ? rows : []).map(r => ({
          table: r.table,
          rls: r.rlsEnabled ? 'on' : 'off',
          policies: Array.isArray(r.policies) ? r.policies.length : 0,
        })), [
          { key: 'table', label: 'TABLE' },
          { key: 'rls', label: 'RLS' },
          { key: 'policies', label: 'POLICIES' },
        ]),
      );
    },
  },
  enable: {
    summary: 'Enable RLS on a table',
    usage: 'motherbase rls enable <table>',
    async run(ctx, args) {
      const table = requireArg(args[0], 'table');
      const data = await api.adminRequest(ctx, 'POST', `/rls/tables/${table}/rls`, { body: { enabled: true } });
      output(ctx, data, (d, ui) => ui.success(`RLS enabled on ${table}`));
    },
  },
  disable: {
    summary: 'Disable RLS on a table',
    usage: 'motherbase rls disable <table>',
    async run(ctx, args) {
      const table = requireArg(args[0], 'table');
      const data = await api.adminRequest(ctx, 'POST', `/rls/tables/${table}/rls`, { body: { enabled: false } });
      output(ctx, data, (d, ui) => ui.success(`RLS disabled on ${table}`));
    },
  },
  policy,
  preset: {
    summary: 'Apply a policy preset to a table',
    usage:
      'motherbase rls preset <table> <starter|public_crud|authenticated_crud|admin_only|blocked|owner_only|org_scoped|public_read_owner_write|soft_delete> [--owner-column c] [--org-column c] [--org-claim c] [--deleted-column c] [--replace]',
    async run(ctx, args, flags) {
      const table = requireArg(args[0], 'table');
      const preset = requireArg(args[1], 'preset');
      const body = { preset };
      if (flags['owner-column']) body.ownerColumn = flags['owner-column'];
      if (flags['org-column']) body.orgColumn = flags['org-column'];
      if (flags['org-claim']) body.orgClaim = flags['org-claim'];
      if (flags['deleted-column']) body.deletedColumn = flags['deleted-column'];
      if (flags.replace) body.replace = true;
      const data = await api.adminRequest(ctx, 'POST', `/rls/tables/${table}/preset`, { body });
      output(ctx, data, (d, ui) =>
        ui.success(`Applied ${preset} to ${table}: ${(d && d.policies ? d.policies : []).join(', ')}`)
      );
    },
  },
  simulate: {
    summary: 'Run a query as a given caller and show what RLS lets through',
    usage:
      'motherbase rls simulate --sql "select * from t" [--as anon|authenticated|<userId>] [--claims \'{"org_id":"x"}\'] [--limit n]',
    async run(ctx, args, flags) {
      const sql = flags.sql || args.join(' ');
      if (!sql) throw new CliError('--sql is required');

      // `--as` takes a role or a user id. A value that is not one of the two
      // roles is treated as a user id, which is what makes "as this person"
      // spellable without looking their claims up by hand.
      const as = flags.as || 'anon';
      const body = { sql };
      if (as === 'anon' || as === 'authenticated') body.role = as;
      else body.userId = as;
      if (flags.claims) {
        try {
          body.claims = JSON.parse(flags.claims);
        } catch {
          throw new CliError('--claims must be a JSON object');
        }
      }
      if (flags.limit) body.limit = Number(flags.limit);

      const data = await api.adminRequest(ctx, 'POST', '/rls/simulate', { body });
      output(ctx, data, (d, ui) => {
        if (d.denied) {
          ui.warn(`Refused by Postgres: ${d.denied.message}`);
        }
        if (d.rows && d.rows.length) {
          ui.table(d.rows, (d.columns || []).map(key => ({ key, label: key.toUpperCase() })));
        } else {
          ui.info('0 rows');
        }
        if (d.truncated) ui.info(`Truncated at ${d.rowCount} rows.`);
        for (const t of d.tables || []) {
          const reason =
            t.deniedBy === 'grant'
              ? 'no privilege for this role'
              : t.deniedBy === 'policy'
                ? 'RLS on, no policy grants this role read access'
                : null;
          ui.info(`${t.schema}.${t.table}: RLS ${t.rlsEnabled ? 'on' : 'off'}${reason ? ` (${reason})` : ''}`);
          for (const p of t.policies || []) {
            ui.info(`  ${p.applies ? '*' : ' '} ${p.name} ${p.command} to ${p.roles.join(',')}: ${p.using || 'true'}`);
          }
        }
      });
    },
  },
  lint: {
    summary: 'Run the security and performance advisor',
    usage: 'motherbase rls lint [--level critical|warning|info]',
    async run(ctx, args, flags) {
      const data = await api.adminRequest(ctx, 'GET', '/advisor');
      const findings = (data && data.findings ? data.findings : []).filter(
        f => !flags.level || f.level === flags.level
      );
      output(ctx, { ...data, findings }, (d, ui) => {
        if (!findings.length) return ui.success('No findings.');
        ui.table(
          findings.map(f => ({ level: f.level, id: f.id, target: f.target, title: f.title })),
          [
            { key: 'level', label: 'LEVEL' },
            { key: 'id', label: 'RULE' },
            { key: 'target', label: 'TARGET' },
            { key: 'title', label: 'FINDING' },
          ]
        );
      });
    },
  },
};

module.exports = {
  summary: 'Row-level security (tables, policies, presets, simulator, lint)',
  usage: 'motherbase rls <list|enable|disable|policy|preset|simulate|lint> ...',
  subcommands,
};
