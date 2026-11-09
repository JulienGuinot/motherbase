'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { triggersApi } from '@/features/database/api/triggers.api';
import { createEmptyTriggerDraft, TRIGGER_EVENTS, triggerDraftSql, type TriggerDraft } from '@/features/database/lib/trigger-draft';
import type { TriggerInfo } from '@/features/database/types';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { optimistic } from '@/shared/lib/optimistic';

/**
 * Rebuild the form from an existing trigger. A trigger the form can express
 * round-trips into its fields; anything else opens in advanced raw-SQL mode
 * seeded with the real definition, so an edit can never silently rewrite it.
 */
function draftFromTrigger(trigger: TriggerInfo): TriggerDraft {
  const simple =
    (trigger.timing === 'BEFORE' || trigger.timing === 'AFTER') &&
    trigger.events.length > 0 &&
    trigger.events.every(ev => (TRIGGER_EVENTS as readonly string[]).includes(ev));

  return {
    editing: { table: trigger.table, name: trigger.name },
    name: trigger.name,
    table: trigger.table,
    timing: trigger.timing === 'BEFORE' ? 'BEFORE' : 'AFTER',
    events: {
      INSERT: trigger.events.includes('INSERT'),
      UPDATE: trigger.events.includes('UPDATE'),
      DELETE: trigger.events.includes('DELETE'),
      TRUNCATE: trigger.events.includes('TRUNCATE'),
    },
    orientation: trigger.orientation,
    fn: trigger.function,
    advanced: !simple,
    rawSql: trigger.definition.endsWith(';') ? trigger.definition : `${trigger.definition};`,
    rawEdited: !simple,
  };
}

/**
 * Every trigger write, plus the draft being edited.
 *
 * @param schema the schema on screen. Every mutation is qualified with it: the
 * reads were scoped and the writes were not, so a trigger listed from a custom
 * schema was dropped or toggled in `public`.
 */
export function useTriggerAdmin(schema: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<TriggerDraft | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['pg-triggers'] });
  const fail = (title: string) => (e: unknown) =>
    toast.push({ kind: 'error', title, message: getErrorMessage(e) });

  const save = useMutation({
    mutationFn: async (value: TriggerDraft) => {
      // Postgres has no ALTER of a trigger body: an edit is drop then create.
      if (value.editing) await triggersApi.drop(value.editing.name, value.editing.table, schema);
      await triggersApi.create(triggerDraftSql(value, schema));
    },
    onSuccess: (_data, value) => {
      invalidate();
      setDraft(null);
      toast.push({ kind: 'success', title: value.editing ? 'Trigger updated' : 'Trigger created' });
    },
    onError: fail('Save failed'),
  });

  const toggle = useMutation({
    mutationFn: (trigger: TriggerInfo) => triggersApi.setEnabled(trigger.name, trigger.table, !trigger.enabled, schema),
    // Keyed by schema, like the query that fills it: an optimistic write into
    // the unscoped key patched a cache entry nothing reads.
    ...optimistic<TriggerInfo[], TriggerInfo>(qc, toast, ['pg-triggers', schema],
      (triggers, trigger) => triggers.map(t =>
        t.name === trigger.name && t.table === trigger.table ? { ...t, enabled: !trigger.enabled } : t),
      'Update failed'),
  });

  const drop = useMutation({
    mutationFn: (trigger: TriggerInfo) => triggersApi.drop(trigger.name, trigger.table, schema),
    onSuccess: () => {
      invalidate();
      toast.push({ kind: 'success', title: 'Trigger dropped' });
    },
    onError: fail('Drop failed'),
  });

  return {
    draft,
    setDraft,
    startCreate: (firstTable: string) => setDraft(createEmptyTriggerDraft(firstTable)),
    startEdit: (trigger: TriggerInfo) => setDraft(draftFromTrigger(trigger)),
    save: (value: TriggerDraft) => save.mutate(value),
    saving: save.isPending,
    toggle: (trigger: TriggerInfo) => toggle.mutate(trigger),
    /** Dropping a trigger is not reversible, so it always asks first. */
    confirmDrop: async (trigger: TriggerInfo) => {
      if (await confirmDialog({ title: `Drop trigger "${trigger.name}"?`, description: `On ${trigger.table}. Rows will stop firing it as soon as it is dropped.`, confirmLabel: 'Drop trigger', tone: 'danger' })) drop.mutate(trigger);
    },
  };
}
