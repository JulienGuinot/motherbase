import { api } from '@/shared/lib/api';
import type { AppJob, AppJobRun, CronRun, PgCronJobsResponse } from '@/features/database/types';

export const cronApi = {
  pgJobs: () => api.get('/admin/cron/pg/jobs').then(r => r.data.data as PgCronJobsResponse),
  appJobs: () =>
    api.get('/admin/cron/app/jobs').then(r => r.data.data as { jobs: AppJob[]; partial: boolean }),
  // The ledger already served this; nothing in the console called it, so a
  // failing app job showed one truncated error and no history at all.
  appJobRuns: (job: string, limit = 25) =>
    api
      .get('/admin/jobs/runs', { params: { job, limit } })
      .then(r => r.data.data.runs as AppJobRun[]),
  jobRuns: (jobid: number | string) =>
    api.get(`/admin/cron/pg/jobs/${jobid}/runs`).then(r => r.data.data.runs as CronRun[]),
  // Forcing a run and editing a cadence: the server has always been able to do
  // both, and the console could only watch.
  runAppJob: (job: string) =>
    api.post(`/admin/jobs/${encodeURIComponent(job)}/run`).then(r => r.data.data as { output: unknown }),
  configureAppJob: (job: string, patch: { schedule?: string | null; enabled?: boolean }) =>
    api.patch(`/admin/jobs/${encodeURIComponent(job)}`, patch),
  enablePgCron: () => api.post('/admin/schema/extensions/pg_cron'),
  createJob: (name: string, schedule: string, command: string) =>
    api.post('/admin/cron/pg/jobs', { name, schedule, command }),
  deleteJob: (jobid: number | string) => api.delete(`/admin/cron/pg/jobs/${jobid}`),
  setActive: (jobid: number | string, active: boolean) =>
    api.patch(`/admin/cron/pg/jobs/${jobid}`, { active }),
};
