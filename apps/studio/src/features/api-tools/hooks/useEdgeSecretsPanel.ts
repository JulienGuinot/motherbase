'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { apiToolsApi } from '@/features/api-tools/api/api-tools.api';
import { useEdgeSecrets } from '@/features/api-tools/hooks/useApiTools';

/** The project secrets panel: the list, and the form that adds to it. */
export function useEdgeSecretsPanel(visible: boolean) {
  const qc = useQueryClient();
  const toast = useToast();
  const [secretName, setSecretName] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const secretsQuery = useEdgeSecrets(visible);

  const refresh = () => qc.invalidateQueries({ queryKey: ['edge-secrets'] });
  const fail = (title: string) => (error: unknown) =>
    toast.push({ kind: 'error', title, message: getErrorMessage(error) });

  const save = useMutation({
    mutationFn: () => apiToolsApi.saveSecret(secretName.trim(), secretValue),
    onSuccess: () => {
      toast.push({ kind: 'success', title: 'Secret saved', message: secretName.trim() });
      setSecretName('');
      setSecretValue('');
      refresh();
    },
    onError: fail('Save failed'),
  });

  const drop = useMutation({
    mutationFn: (secret: string) => apiToolsApi.deleteSecret(secret),
    onSuccess: (_response, secret) => {
      toast.push({ kind: 'success', title: 'Secret deleted', message: secret });
      refresh();
    },
    onError: fail('Delete failed'),
  });

  return {
    secrets: secretsQuery.data,
    secretName,
    setSecretName,
    secretValue,
    setSecretValue,
    saveSecret: () => save.mutate(),
    savingSecret: save.isPending,
    deleteSecret: (secret: string) => drop.mutate(secret),
  };
}
