'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { vaultApi, type VaultSecret, type VaultSecretInput } from '@/features/integrations/api/vault.api';

export function useVault() {
  return useQuery({ queryKey: ['vault'], queryFn: vaultApi.list });
}

/**
 * Vault writes. None of them paints ahead of the server: a secret the console
 * shows as saved and the database does not hold is exactly the failure a
 * secret store must not have.
 */
export function useVaultAdmin() {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => qc.invalidateQueries({ queryKey: ['vault'] });
  const fail = (title: string) => (e: unknown) => toast.push({ kind: 'error', title, message: getErrorMessage(e) });

  const enable = useMutation({
    mutationFn: vaultApi.enable,
    onSuccess: () => {
      void refresh();
      toast.push({ kind: 'success', title: 'Vault enabled' });
    },
    onError: fail('Could not enable Vault'),
  });

  const save = useMutation({
    mutationFn: (args: { id?: string; input: Partial<VaultSecretInput> }) =>
      args.id ? vaultApi.update(args.id, args.input) : vaultApi.create(args.input as VaultSecretInput),
    onSuccess: (secret, args) => {
      void refresh();
      toast.push({ kind: 'success', title: args.id ? `${secret.name} updated` : `${secret.name} stored` });
    },
    onError: fail('Could not save the secret'),
  });

  const remove = useMutation({
    mutationFn: (secret: VaultSecret) => vaultApi.remove(secret.id),
    onSuccess: () => {
      void refresh();
      toast.push({ kind: 'success', title: 'Secret deleted' });
    },
    onError: fail('Delete failed'),
  });

  return {
    enable,
    save,
    confirmRemove: async (secret: VaultSecret) => {
      const ok = await confirmDialog({
        title: `Delete secret "${secret.name ?? secret.id}"?`,
        description: 'Anything that reads it from vault.decrypted_secrets stops working. This cannot be undone.',
        confirmLabel: 'Delete secret',
        tone: 'danger',
      });
      if (ok) remove.mutate(secret);
    },
  };
}
