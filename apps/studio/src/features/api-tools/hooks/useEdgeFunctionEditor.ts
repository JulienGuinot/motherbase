'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { apiToolsApi } from '@/features/api-tools/api/api-tools.api';
import { useEdgeFunctionLogs, useEdgeFunctions } from '@/features/api-tools/hooks/useApiTools';
import { useEdgeSecretsPanel } from '@/features/api-tools/hooks/useEdgeSecretsPanel';
import { useProjectApiBase } from '@/features/api-tools/hooks/useProjectApiBase';
import type { EdgeFunctionTab } from '@/features/api-tools/components/EdgeFunctionWorkspace';
import type { EdgeFn, InvokeResult } from '@/features/api-tools/types';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { optimistic } from '@/shared/lib/optimistic';
import { invalidateFor } from '@/shared/lib/invalidate';

export const EDGE_FUNCTION_TEMPLATE = `// Edge function receives "context" from the invoke payload.
// Project secrets are available as "env.NAME".
// "sendMail({ to, subject, text })" sends through this project's SMTP settings.
// Return any JSON-serializable value.
(async (context) => {
  console.log('invoked with', JSON.stringify(context));
  return { message: 'Hello from ' + context.name };
})(context)`;

/**
 * The edge-function workbench: which function is open, its editor buffer, the
 * invoke round trip, and the project secrets panel.
 */
export function useEdgeFunctionEditor() {
  const qc = useQueryClient();
  const toast = useToast();

  const [selected, setSelected] = useState<EdgeFn | null>(null);
  const [isNew, setIsNew] = useState(false);
  // `?panel=secrets` opens straight onto the secrets panel: the Supabase import
  // ends with a list of secrets to set by hand and links here.
  const [showSecrets, setShowSecrets] = useState(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('panel') === 'secrets'
  );
  const [tab, setTab] = useState<EdgeFunctionTab>('editor');
  const [code, setCode] = useState(EDGE_FUNCTION_TEMPLATE);
  const [schedule, setSchedule] = useState('');
  const [name, setName] = useState('');
  const [route, setRoute] = useState('');
  const [invokeBody, setInvokeBody] = useState('{\n  "name": "world"\n}');
  const [invokeResult, setInvokeResult] = useState<InvokeResult | null>(null);

  const listQuery = useEdgeFunctions();
  const logsQuery = useEdgeFunctionLogs(selected?.id, tab === 'logs');
  const secretsPanel = useEdgeSecretsPanel(showSecrets);
  const apiBase = useProjectApiBase();

  /** Also the app-job list: a scheduled function is a job there. */
  const invalidate = () => invalidateFor(qc, 'edge-function.changed');
  const fail = (title: string) => (error: unknown) =>
    toast.push({ kind: 'error', title, message: getErrorMessage(error) });

  const create = useMutation({
    mutationFn: () => apiToolsApi.createEdgeFunction({ name, route, code }),
    onSuccess: response => {
      const fn = response.data.data.function as EdgeFn;
      toast.push({ kind: 'success', title: 'Function created', message: fn.name });
      invalidate();
      setSelected(fn);
      setIsNew(false);
      setTab('editor');
    },
    onError: fail('Create failed'),
  });

  const save = useMutation({
    mutationFn: () => apiToolsApi.updateEdgeFunction(selected!.id, { code, schedule: schedule.trim() || null }),
    onSuccess: response => {
      toast.push({ kind: 'success', title: 'Saved' });
      invalidate();
      setSelected(response.data.data.function as EdgeFn);
    },
    onError: fail('Save failed'),
  });

  const drop = useMutation({
    mutationFn: (id?: string) => apiToolsApi.deleteEdgeFunction(id ?? selected!.id),
    onSuccess: (_response, id) => {
      toast.push({ kind: 'success', title: 'Deleted' });
      invalidate();
      if (!id || id === selected?.id) {
        setSelected(null);
        setInvokeResult(null);
      }
    },
    onError: fail('Delete failed'),
  });

  // No success toast: the switch moving under the cursor already says it
  // worked, and a popup per click is noise, not confirmation.
  const toggle = useMutation({
    mutationFn: (fn: EdgeFn) => apiToolsApi.updateEdgeFunction(fn.id, { enabled: !fn.enabled }),
    ...optimistic<EdgeFn[], EdgeFn>(qc, toast, ['edge-functions'],
      (fns, fn) => fns.map(f => (f.id === fn.id ? { ...f, enabled: !fn.enabled } : f)),
      'Update failed'),
  });

  const setPublic = useMutation({
    mutationFn: (isPublic: boolean) => apiToolsApi.updateEdgeFunction(selected!.id, { isPublic }),
    onSuccess: response => {
      invalidate();
      setSelected(response.data.data.function as EdgeFn);
    },
    onError: fail('Update failed'),
  });

  const invoke = useMutation({
    mutationFn: async () => {
      let body: unknown;
      try {
        body = JSON.parse(invokeBody);
      } catch {
        throw new Error('Invalid JSON in invoke body');
      }
      return apiToolsApi.invokeEdgeFunction(selected!.id, body);
    },
    onSuccess: result => {
      setInvokeResult(result);
      qc.invalidateQueries({ queryKey: ['edge-function-logs', selected?.id] });
    },
    onError: fail('Invoke failed'),
  });

  return {
    functions: listQuery.data ?? [],
    listLoading: listQuery.isLoading,
    selected,
    isNew,
    showSecrets,
    tab,
    setTab,
    code,
    setCode,
    schedule,
    setSchedule,
    name,
    setName,
    route,
    setRoute,
    invokeBody,
    setInvokeBody,
    invokeResult,
    logs: logsQuery.data,
    logsLoading: logsQuery.isLoading,
    invokeUrl: (fnRoute: string) => `${apiBase}/api/edge/${encodeURIComponent(fnRoute)}`,
    openSecrets: () => {
      setShowSecrets(true);
      setSelected(null);
      setIsNew(false);
    },
    startNew: () => {
      setShowSecrets(false);
      setIsNew(true);
      setSelected(null);
      setCode(EDGE_FUNCTION_TEMPLATE);
      setSchedule('');
      setName('');
      setRoute('');
      setInvokeResult(null);
      setTab('editor');
    },
    open: (fn: EdgeFn, nextTab: EdgeFunctionTab = 'editor') => {
      setShowSecrets(false);
      setSelected(fn);
      setCode(fn.code);
      setSchedule(fn.schedule ?? '');
      setIsNew(false);
      setTab(nextTab);
      setInvokeResult(null);
    },
    create: () => create.mutate(),
    creating: create.isPending,
    save: () => save.mutate(),
    saving: save.isPending,
    deleteSelected: () => drop.mutate(undefined),
    deleting: drop.isPending,
    /** Deleting a function breaks any caller of its route, so it asks first. */
    confirmDelete: async (fn: EdgeFn) => {
      if (await confirmDialog({ title: `Delete "${fn.name}"?`, description: 'Every caller of its route starts getting 404s.', confirmLabel: 'Delete function', tone: 'danger' })) drop.mutate(fn.id);
    },
    toggleEnabled: (fn: EdgeFn) => toggle.mutate(fn),
    /** Opening a route to anonymous callers asks first; closing it never does. */
    togglePublic: async () => {
      if (!selected) return;
      if (selected.isPublic) return setPublic.mutate(false);
      const ok = await confirmDialog({
        title: `Make "${selected.name}" public?`,
        description: 'Anyone with the URL can call it, with no session and no invoke token. Meant for webhook receivers: check the sender\'s signature inside the function.',
        confirmLabel: 'Make public',
        tone: 'danger',
      });
      if (ok) setPublic.mutate(true);
    },
    togglingPublic: setPublic.isPending,
    invoke: () => invoke.mutate(),
    invoking: invoke.isPending,
    ...secretsPanel,
  };
}
