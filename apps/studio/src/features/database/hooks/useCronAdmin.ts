'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { cronApi } from '@/features/database/api/cron.api';
import type { PgCronJob, PgCronJobsResponse } from '@/features/database/types';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { optimistic } from '@/shared/lib/optimistic';

export interface CronDraft {
  editing?: PgCronJob;
  name: string;
  schedule: string;
  command: string;
}

export const emptyCronDraft = (): CronDraft => ({ name: '', schedule: '', command: '' });

export const cronDraftIsComplete = (draft: CronDraft): boolean =>
  Boolean(draft.name.trim() && draft.schedule.trim() && draft.command.trim());

/**
 * Every pg_cron write, plus the draft being edited. The list, the context menu
 * and the modal all drive the same operations from here, so the page is left
 * with composition only.
 */
export function useCronAdmin() {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<CronDraft | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['cron-pg-jobs'] });
  const fail = (title: string) => (e: unknown) =>
    toast.push({ kind: 'error', title, message: getErrorMessage(e) });

  const enableExtension = useMutation({
    mutationFn: () => cronApi.enablePgCron(),
    onSuccess: () => {
      invalidate();
      toast.push({ kind: 'success', title: 'pg_cron enabled' });
    },
    onError: fail('Could not enable pg_cron'),
  });

  const create = useMutation({
    mutationFn: (d: CronDraft) => cronApi.createJob(d.name, d.schedule, d.command),
    onSuccess: () => {
      invalidate();
      setDraft(null);
      toast.push({ kind: 'success', title: 'Job created' });
    },
    onError: fail('Create failed'),
  });

  const update = useMutation({
    // pg_cron has no rename, so an edit is a delete followed by a create.
    mutationFn: async (d: CronDraft) => {
      if (!d.editing) return;
      await cronApi.deleteJob(d.editing.jobid);
      await cronApi.createJob(d.name, d.schedule, d.command);
    },
    onSuccess: () => {
      invalidate();
      setDraft(null);
      toast.push({ kind: 'success', title: 'Job updated' });
    },
    onError: fail('Update failed'),
  });

  const toggle = useMutation({
    mutationFn: (job: PgCronJob) => cronApi.setActive(job.jobid, !job.active),
    // Typed against the response envelope, not against a bare array: the cache
    // holds `{ jobs, extensionMissing }`, and mapping over that object threw
    // before the request left the browser.
    ...optimistic<PgCronJobsResponse, PgCronJob>(qc, toast, ['cron-pg-jobs'],
      (current, job) => ({
        ...current,
        jobs: current.jobs.map(j => (j.jobid === job.jobid ? { ...j, active: !job.active } : j)),
      }),
      'Update failed'),
  });

  const remove = useMutation({
    mutationFn: (job: PgCronJob) => cronApi.deleteJob(job.jobid),
    onSuccess: () => {
      invalidate();
      toast.push({ kind: 'success', title: 'Job deleted' });
    },
    onError: fail('Delete failed'),
  });

  return {
    draft,
    setDraft,
    startCreate: () => setDraft(emptyCronDraft()),
    startEdit: (job: PgCronJob) =>
      setDraft({ editing: job, name: job.jobname, schedule: job.schedule, command: job.command }),
    save: () => {
      if (!draft || !cronDraftIsComplete(draft)) return;
      if (draft.editing) update.mutate(draft);
      else create.mutate(draft);
    },
    saving: create.isPending || update.isPending,
    enableExtension: () => enableExtension.mutate(),
    enablingExtension: enableExtension.isPending,
    toggle: (job: PgCronJob) => toggle.mutate(job),
    /** Deleting a schedule is not reversible, so it always asks first. */
    confirmRemove: async (job: PgCronJob) => {
      if (await confirmDialog({ title: `Delete cron job "${job.jobname}"?`, description: 'The schedule stops immediately and is not recoverable.', confirmLabel: 'Delete job', tone: 'danger' })) remove.mutate(job);
    },
  };
}
