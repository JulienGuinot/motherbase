'use strict';

const api = require('../api');
const { output, requireArg } = require('./_util');
const { CliError } = require('../context');

const subcommands = {
  list: {
    summary: 'List pg_cron jobs (and app jobs with --app)',
    usage: 'motherbase cron list [--app]',
    async run(ctx, args, flags) {
      if (flags.app) {
        const data = await api.adminRequest(ctx, 'GET', '/cron/app/jobs');
        const jobs = (data && data.jobs) || [];
        output(ctx, data, (_d, ui) => ui.table(jobs, [{ key: 'name', label: 'NAME' }, { key: 'schedule', label: 'SCHEDULE' }]));
        return;
      }
      const data = await api.adminRequest(ctx, 'GET', '/cron/pg/jobs');
      const jobs = Array.isArray(data) ? data : (data && data.jobs) || [];
      output(ctx, data, (_d, ui) =>
        ui.table(jobs, [
          { key: 'jobid', label: 'ID' },
          { key: 'jobname', label: 'NAME' },
          { key: 'schedule', label: 'SCHEDULE' },
          { key: 'active', label: 'ACTIVE' },
        ]),
      );
    },
  },
  create: {
    summary: 'Create a pg_cron job',
    usage: 'motherbase cron create --name <n> --schedule "<cron>" --command "<sql>"',
    async run(ctx, args, flags) {
      if (!flags.name || !flags.schedule || !flags.command) throw new CliError('--name, --schedule and --command are required');
      const body = { name: flags.name, schedule: flags.schedule, command: flags.command };
      const data = await api.adminRequest(ctx, 'POST', '/cron/pg/jobs', { body });
      output(ctx, data, (d, ui) => ui.success(`Created cron job ${flags.name}`));
    },
  },
  delete: {
    summary: 'Delete a pg_cron job by numeric id',
    usage: 'motherbase cron delete <id>',
    async run(ctx, args) {
      const id = requireArg(args[0], 'id');
      const data = await api.adminRequest(ctx, 'DELETE', `/cron/pg/jobs/${id}`);
      output(ctx, data, (d, ui) => ui.success(`Deleted cron job ${id}`));
    },
  },
  toggle: {
    summary: 'Enable/disable a pg_cron job',
    usage: 'motherbase cron toggle <id> --active <true|false>',
    async run(ctx, args, flags) {
      const id = requireArg(args[0], 'id');
      const active = flags.active === undefined ? true : flags.active === 'true' || flags.active === true;
      const data = await api.adminRequest(ctx, 'PATCH', `/cron/pg/jobs/${id}`, { body: { active } });
      output(ctx, data, (d, ui) => ui.success(`Cron job ${id} active=${active}`));
    },
  },
};

module.exports = {
  summary: 'Scheduled jobs (pg_cron)',
  usage: 'motherbase cron <list|create|delete|toggle> ...',
  subcommands,
};
