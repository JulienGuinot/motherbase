'use client';

import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';

interface Rollback<TData> {
  previous: TData | undefined;
}

/**
 * The three mutation handlers that make a control respond on click instead of
 * on round trip: paint the expected result immediately, put the old one back if
 * the server disagrees, and reconcile with the truth either way.
 *
 * Nothing in this console did this, so every switch, every checkbox and every
 * enable/disable sat in its old position until a PATCH and the refetch behind
 * it had both landed: a quarter second on localhost and much worse over a VPN,
 * which is exactly the interval that reads as a broken control rather than a
 * slow one.
 *
 * Spread the result into `useMutation`. Pass `apply` a pure updater: it gets
 * the cached value and the mutation variables, and returns the cache as it
 * should look once the call succeeds.
 *
 *   const patch = optimistic<Hook[], Hook>(qc, toast, ['webhooks'], (hooks, hook) =>
 *     hooks.map(h => (h.id === hook.id ? { ...h, enabled: !h.enabled } : h)), 'Update failed');
 *   const toggle = useMutation({ mutationFn: ..., ...patch });
 */
export function optimistic<TData, TVars>(
  qc: QueryClient,
  toast: { push: (t: { kind: 'error'; title: string; message?: string }) => void },
  queryKey: QueryKey,
  apply: (current: TData, variables: TVars) => TData,
  failTitle: string,
) {
  return {
    onMutate: async (variables: TVars): Promise<Rollback<TData>> => {
      // An in-flight refetch would land after the optimistic write and put the
      // stale value straight back on screen.
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<TData>(queryKey);
      if (previous !== undefined) qc.setQueryData<TData>(queryKey, apply(previous, variables));
      return { previous };
    },
    onError: (error: unknown, _variables: TVars, context: Rollback<TData> | undefined) => {
      if (context?.previous !== undefined) qc.setQueryData(queryKey, context.previous);
      toast.push({ kind: 'error', title: failTitle, message: getErrorMessage(error) });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey });
    },
  };
}
