'use client';

import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';

/**
 * A write that refetches `key` and says how it went. Nothing is written to the
 * cache ahead of the server: every surface using this changes infrastructure
 * (a stack, a certificate, pg_hba.conf), and showing that before it happened
 * would be a lie with consequences.
 */
export function useToastMutation<TVars, TData>(
  key: QueryKey,
  mutationFn: (vars: TVars) => Promise<TData>,
  messages: { success: string | ((data: TData) => string); failure: string },
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn,
    onSuccess: data => {
      void qc.invalidateQueries({ queryKey: key });
      toast.push({ kind: 'success', title: typeof messages.success === 'function' ? messages.success(data) : messages.success });
    },
    onError: error => toast.push({ kind: 'error', title: messages.failure, message: getErrorMessage(error) }),
  });
}
