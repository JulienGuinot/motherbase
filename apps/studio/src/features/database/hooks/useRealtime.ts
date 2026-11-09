import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { keepPreviousFor } from '@/shared/lib/query';
import { getErrorMessage } from '@/shared/lib/errors';
import { optimistic } from '@/shared/lib/optimistic';
import { useToast } from '@/shared/lib/toast';
import { realtimeApi } from '@/features/database/api/realtime.api';
import type { PgPolicy } from '@/features/database/lib/rls-api';
import type { RealtimePolicyDraft } from '@/features/database/lib/realtime-policies';

export function useRealtimeChannels() {
  return useQuery({
    queryKey: ['rt-channels'],
    queryFn: realtimeApi.channels,
    refetchInterval: 3000,
  });
}

export function useRealtimeEvents(selectedChannel: string | null) {
  return useQuery({
    // Keep the previous result on screen while the new selection loads.
    placeholderData: keepPreviousFor(selectedChannel),
    queryKey: ['rt-events', selectedChannel],
    queryFn: () => realtimeApi.events(selectedChannel),
    refetchInterval: 2000,
  });
}

export function useRealtimePresence(selectedChannel: string | null) {
  return useQuery({
    // Keep the previous result on screen while the new selection loads.
    placeholderData: keepPreviousFor(selectedChannel),
    queryKey: ['rt-presence', selectedChannel],
    enabled: Boolean(selectedChannel),
    queryFn: () => realtimeApi.presence(selectedChannel!),
    refetchInterval: 5000,
  });
}

/** Durable-queue health, refreshed alongside the inspector. */
export function useRealtimeQueue() {
  return useQuery({ queryKey: ['rt-queue'], queryFn: realtimeApi.queue, refetchInterval: 5000 });
}

export function useRealtimeConfig() {
  return useQuery({ queryKey: ['rt-config'], queryFn: realtimeApi.config });
}

const POLICIES_KEY = ['rt-policies'];

/** Policies on `realtime.messages`, with create and (optimistic) drop. */
export function useRealtimePolicies() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: POLICIES_KEY, queryFn: realtimeApi.policies });

  const create = useMutation({
    mutationFn: (draft: RealtimePolicyDraft) => realtimeApi.createPolicy(draft),
    onSuccess: (_response, draft) => {
      toast.push({ kind: 'success', title: 'Policy created', message: draft.name });
      void qc.invalidateQueries({ queryKey: POLICIES_KEY });
    },
    onError: error => toast.push({ kind: 'error', title: 'Create failed', message: getErrorMessage(error) }),
  });

  const drop = useMutation({
    mutationFn: (name: string) => realtimeApi.dropPolicy(name),
    ...optimistic<PgPolicy[], string>(qc, toast, POLICIES_KEY,
      (policies, name) => policies.filter(policy => policy.name !== name), 'Delete failed'),
  });

  return { list, create, drop };
}
