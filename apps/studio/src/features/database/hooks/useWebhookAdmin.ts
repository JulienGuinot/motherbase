'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { webhooksApi } from '@/features/database/api/webhooks.api';
import type { Hook } from '@/features/database/types';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { optimistic } from '@/shared/lib/optimistic';

export interface WebhookDraft {
  id?: string;
  name: string;
  url: string;
  events: string[];
}

export const emptyWebhookDraft = (): WebhookDraft => ({ name: '', url: '', events: ['*'] });

export const webhookDraftIsComplete = (draft: WebhookDraft): boolean =>
  Boolean(draft.name && draft.url && draft.events.length > 0);

/**
 * Every webhook write, plus the draft being edited. The list, the context menu
 * and the drawer share these operations rather than each holding a copy.
 */
export function useWebhookAdmin() {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<WebhookDraft | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['webhooks'] });
  const fail = (title: string) => (e: unknown) =>
    toast.push({ kind: 'error', title, message: getErrorMessage(e) });

  const create = useMutation({
    mutationFn: (payload: WebhookDraft) =>
      webhooksApi.create({ name: payload.name, url: payload.url, events: payload.events }),
    onSuccess: () => {
      invalidate();
      setDraft(null);
      toast.push({ kind: 'success', title: 'Webhook created', message: 'Saved on the server.' });
    },
    onError: fail('Create failed'),
  });

  const update = useMutation({
    mutationFn: (payload: WebhookDraft & { id: string }) =>
      webhooksApi.update(payload.id, { name: payload.name, url: payload.url, events: payload.events }),
    onSuccess: () => {
      invalidate();
      setDraft(null);
      toast.push({ kind: 'success', title: 'Webhook updated' });
    },
    onError: fail('Update failed'),
  });

  const toggle = useMutation({
    mutationFn: (hook: Hook) => webhooksApi.update(hook.id, { enabled: !hook.enabled }),
    ...optimistic<Hook[], Hook>(qc, toast, ['webhooks'],
      (hooks, hook) => hooks.map(h => (h.id === hook.id ? { ...h, enabled: !hook.enabled } : h)),
      'Update failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => webhooksApi.remove(id),
    onSuccess: () => {
      invalidate();
      toast.push({ kind: 'success', title: 'Webhook deleted' });
    },
    onError: fail('Delete failed'),
  });

  const test = useMutation({
    mutationFn: (id: string) => webhooksApi.test(id),
    onSuccess: r =>
      toast.push({
        kind: r.ok ? 'success' : 'error',
        title: r.ok ? 'Test payload delivered' : 'Test payload rejected',
        message: `HTTP ${r.status} · ${r.ms}ms`,
      }),
    onError: fail('Test failed'),
  });

  return {
    draft,
    setDraft,
    startCreate: () => setDraft(emptyWebhookDraft()),
    startEdit: (hook: Hook) => setDraft({ id: hook.id, name: hook.name, url: hook.url, events: [...hook.events] }),
    save: () => {
      if (!draft || !webhookDraftIsComplete(draft)) return;
      if (draft.id) update.mutate({ ...draft, id: draft.id });
      else create.mutate(draft);
    },
    saving: create.isPending || update.isPending,
    toggle: (hook: Hook) => toggle.mutate(hook),
    test: (id: string) => test.mutate(id),
    testing: test.isPending,
    /** Removing a destination silently drops future events, so it asks first. */
    confirmRemove: async (hook: Hook) => {
      if (await confirmDialog({ title: `Delete webhook "${hook.name}"?`, description: 'Future events stop being delivered to this destination.', confirmLabel: 'Delete webhook', tone: 'danger' })) remove.mutate(hook.id);
    },
  };
}
