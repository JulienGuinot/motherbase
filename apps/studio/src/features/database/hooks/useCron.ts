import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { keepPreviousFor } from '@/shared/lib/query';
import { cronApi } from '@/features/database/api/cron.api';

export function usePgCronJobs() {
  return useQuery({ queryKey: ['cron-pg-jobs'], queryFn: cronApi.pgJobs });
}

export function useAppCronJobs(enabled: boolean) {
  return useQuery({
    queryKey: ['cron-app-jobs'],
    queryFn: cronApi.appJobs,
    enabled,
    // Job status is exactly the thing an operator leaves open and watches. The
    // provider turns off refetch-on-focus globally, so without this the page
    // froze on whatever it fetched when it mounted. Same cadence as pg_cron's
    // run history, which already polls.
    refetchInterval: 5000,
  });
}

/** Recorded runs of one app job, from `platform.job_runs`. */
export function useAppJobRuns(job: string) {
  return useQuery({
    placeholderData: keepPreviousFor(job),
    queryKey: ['app-job-runs', job],
    queryFn: () => cronApi.appJobRuns(job),
    refetchInterval: 5000,
  });
}

/**
 * Force one run, then refresh both the job list and that job's history.
 *
 * Invalidating rather than writing an optimistic row: the run's outcome is the
 * whole point, and a green row the console invented would be a claim it has no
 * basis for.
 */
export function useRunAppJob(job: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => cronApi.runAppJob(job),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['app-job-runs', job] });
      void qc.invalidateQueries({ queryKey: ['cron-app-jobs'] });
    },
  });
}

/** Change a job's cadence, or arm and disarm it. */
export function useConfigureAppJob(job: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { schedule?: string | null; enabled?: boolean }) =>
      cronApi.configureAppJob(job, patch),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['cron-app-jobs'] });
    },
  });
}

export function useCronJobRuns(jobid: number | string) {
  return useQuery({
    // Keep the previous result on screen while the new selection loads.
    placeholderData: keepPreviousFor(jobid),
    queryKey: ['cron-job-runs', jobid],
    queryFn: () => cronApi.jobRuns(jobid),
    refetchInterval: 5000,
  });
}
