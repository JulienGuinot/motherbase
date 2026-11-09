'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { migrationsApi } from '@/features/database/api/migrations.api';
import { emptyDraft, type DiffResult, type Draft } from '@/features/database/types';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { invalidateFor } from '@/shared/lib/invalidate';

/**
 * Every migration write, plus the draft and the pending diff. Apply and roll
 * back always confirm: both run SQL against the live database.
 */
export function useMigrationAdmin() {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);

  /** The list only: creating or deleting a migration runs no SQL. */
  const invalidate = () => qc.invalidateQueries({ queryKey: ['migrations'] });
  /**
   * Apply and rollback run DDL, so everything describing the database is
   * potentially stale: tables, rows, schemas, functions, policies. Refreshing
   * only the migration list left the rest of the console on the old shape.
   */
  const invalidateSchema = () => invalidateFor(qc, 'schema.changed');
  const fail = (title: string) => (e: unknown) =>
    toast.push({ kind: 'error', title, message: getErrorMessage(e) });

  const create = useMutation({
    mutationFn: (value: Draft) => migrationsApi.create(value),
    onSuccess: () => {
      invalidate();
      setDraft(null);
      toast.push({ kind: 'success', title: 'Migration created' });
    },
    onError: fail('Create failed'),
  });

  const apply = useMutation({
    mutationFn: (id: string) => migrationsApi.apply(id),
    onSuccess: () => {
      void invalidateSchema();
      toast.push({ kind: 'success', title: 'Migration applied' });
    },
    onError: fail('Apply failed'),
  });

  const rollback = useMutation({
    mutationFn: (id: string) => migrationsApi.rollback(id),
    onSuccess: () => {
      void invalidateSchema();
      toast.push({ kind: 'success', title: 'Migration rolled back' });
    },
    onError: fail('Rollback failed'),
  });

  const repair = useMutation({
    mutationFn: ({ version, status }: { version: string; status: 'applied' | 'reverted' }) =>
      migrationsApi.repair(version, status),
    onSuccess: (_data, { status }) => {
      invalidate();
      toast.push({ kind: 'success', title: status === 'applied' ? 'Marked as applied' : 'Marked as reverted' });
    },
    onError: fail('Repair failed'),
  });

  const runDiff = useMutation({
    mutationFn: () => migrationsApi.diff(),
    onSuccess: setDiff,
    onError: fail('Diff failed'),
  });

  return {
    draft,
    setDraft,
    startNew: () => setDraft(emptyDraft()),
    /** Seed a new migration from the diff the server proposed. */
    startFromDiff: (sql: string) => {
      setDiff(null);
      setDraft({ ...emptyDraft(), upSql: sql });
    },
    create: (value: Draft) => create.mutate(value),
    creating: create.isPending,
    diff,
    clearDiff: () => setDiff(null),
    runDiff: () => runDiff.mutate(),
    diffing: runDiff.isPending,
    confirmApply: async (id: string, name = 'this migration') => {
      if (await confirmDialog({ title: `Apply migration "${name}"?`, description: 'The migration runs against this project’s database now.', confirmLabel: 'Apply' })) apply.mutate(id);
    },
    applying: apply.isPending,
    confirmRollback: async (id: string, name = 'this migration') => {
      if (await confirmDialog({ title: `Roll back migration "${name}"?`, description: 'Anything the migration created may be dropped.', confirmLabel: 'Roll back', tone: 'danger' })) rollback.mutate(id);
    },
    rollingBack: rollback.isPending,
    /**
     * History only, no SQL runs: for a schema that already has (or lacks) the
     * change, e.g. applied by hand or restored from a dump. Same as
     * `motherbase migration repair`.
     */
    confirmRepair: async (version: string, status: 'applied' | 'reverted', name = version) => {
      const applied = status === 'applied';
      if (await confirmDialog({
        title: applied ? `Mark "${name}" as applied?` : `Mark "${name}" as reverted?`,
        description: applied
          ? 'Records the migration as applied without running it. Use this when the database already has the change.'
          : 'Records the migration as not applied without running its down SQL. The next push applies it again.',
        confirmLabel: applied ? 'Mark applied' : 'Mark reverted',
      })) repair.mutate({ version, status });
    },
    repairing: repair.isPending,
  };
}
