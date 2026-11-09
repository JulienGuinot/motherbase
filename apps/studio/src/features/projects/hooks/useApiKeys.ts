'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { apiKeysApi, type ApiKeyType, type CreatedApiKey } from '@/features/projects/api/api-keys.api';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';

const KEY = ['project-api-keys'];

/**
 * The key list plus its two writes.
 *
 * `justCreated` holds the one and only readable copy of a freshly minted secret
 * key. It lives in component state deliberately: it must not be refetchable, so
 * it cannot be in the query cache, and it must not survive a reload.
 */
export function useApiKeys() {
  const qc = useQueryClient();
  const toast = useToast();
  const [justCreated, setJustCreated] = useState<CreatedApiKey | null>(null);

  const query = useQuery({ queryKey: KEY, queryFn: apiKeysApi.list });
  const invalidate = () => qc.invalidateQueries({ queryKey: KEY });

  const create = useMutation({
    mutationFn: ({ name, type }: { name: string; type: ApiKeyType }) => apiKeysApi.create(name, type),
    onSuccess: created => {
      invalidate();
      if (created.type === 'secret') setJustCreated(created);
      toast.push({ kind: 'success', title: `${created.type === 'secret' ? 'Secret' : 'Publishable'} key created` });
    },
    onError: e => toast.push({ kind: 'error', title: 'Create failed', message: getErrorMessage(e) }),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => apiKeysApi.revoke(id),
    onSuccess: () => {
      invalidate();
      toast.push({ kind: 'success', title: 'Key revoked', message: 'Requests presenting it now fail.' });
    },
    onError: e => toast.push({ kind: 'error', title: 'Revoke failed', message: getErrorMessage(e) }),
  });

  return {
    keys: query.data ?? [],
    loading: query.isLoading,
    error: query.error,
    justCreated,
    dismissCreated: () => setJustCreated(null),
    create: (name: string, type: ApiKeyType) => create.mutate({ name, type }),
    creating: create.isPending,
    /** Revoking cuts every caller holding the key, so it asks first. */
    confirmRevoke: async (id: string, name: string) => {
      if (await confirmDialog({ title: `Revoke "${name}"?`, description: 'Any app still sending this key starts failing immediately.', confirmLabel: 'Revoke key', tone: 'danger' })) revoke.mutate(id);
    },
    revoking: revoke.isPending,
  };
}
