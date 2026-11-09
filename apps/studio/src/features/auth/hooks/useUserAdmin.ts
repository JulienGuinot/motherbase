'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { usersApi, type CreateUserPayload, type UpdateUserPayload } from '@/features/auth/api/users.api';
import type { AdminUser, UserAction } from '@/features/auth/types';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { invalidateFor } from '@/shared/lib/invalidate';

export type { UserAction } from '@/features/auth/types';

/**
 * Every write the users screen can perform, with its toasts and cache
 * invalidation. Kept out of the page so the page is composition only, and so
 * the table, the drawer and the context menu all call the same operation.
 */
export function useUserAdmin({ onInvited }: { onInvited?: () => void } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [createdPassword, setCreatedPassword] = useState<string | null>(null);
  // The list, the drawer detail and the global sessions page all describe the
  // same user. Refreshing only `users` left a revoked session listed and a
  // stale role in the drawer.
  const invalidate = () => invalidateFor(qc, 'user.changed');

  const act = useMutation({
    mutationFn: (args: { id: string; action: UserAction }) => usersApi.action(args.id, args.action),
    onSuccess: (_data, vars) => {
      invalidate();
      toast.push({ kind: 'success', title: 'Done', message: `Action ${vars.action} applied` });
    },
    onError: e => toast.push({ kind: 'error', title: 'Action failed', message: getErrorMessage(e) }),
  });

  const resetPassword = useMutation({
    mutationFn: (args: { id: string; password: string }) => usersApi.resetPassword(args.id, args.password),
    onSuccess: () => {
      // A password reset ends the user's sessions server-side.
      void invalidateFor(qc, 'session.revoked');
      toast.push({ kind: 'success', title: 'Password updated' });
    },
    onError: e => toast.push({ kind: 'error', title: 'Reset failed', message: getErrorMessage(e) }),
  });

  const update = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateUserPayload }) => usersApi.update(id, payload),
    onSuccess: () => {
      toast.push({ kind: 'success', title: 'User updated' });
    },
    onError: e => toast.push({ kind: 'error', title: 'Update failed', message: getErrorMessage(e) }),
    onSettled: () => invalidate(),
  });

  const verification = useMutation({
    mutationFn: ({ id, verified }: { id: string; verified: boolean }) => usersApi.setEmailVerified(id, verified),
    onSuccess: async () => {
      await invalidate();
      toast.push({ kind: 'success', title: 'Email verification updated' });
    },
    onError: e => toast.push({ kind: 'error', title: 'Verification failed', message: getErrorMessage(e) }),
  });

  const create = useMutation({
    mutationFn: (payload: CreateUserPayload) => usersApi.create(payload),
    onSuccess: ({ data }) => {
      invalidate();
      setCreatedPassword((data.data?.temporaryPassword as string | undefined) ?? null);
      if (data.data?.invited) {
        // An invite issues no temporary password, so there is nothing left to
        // copy and the form can close itself.
        onInvited?.();
        toast.push({ kind: 'success', title: 'Invitation sent' });
      } else {
        toast.push({ kind: 'success', title: 'User created', message: 'Copy the temporary password before closing.' });
      }
    },
    onError: e => toast.push({ kind: 'error', title: 'Create failed', message: getErrorMessage(e) }),
  });


  const remove = useMutation({
    mutationFn: (id: string) => usersApi.remove(id),
    onSuccess: () => {
      invalidate();
      toast.push({ kind: 'success', title: 'User deleted' });
    },
    onError: e => toast.push({ kind: 'error', title: 'Delete failed', message: getErrorMessage(e) }),
  });

  return {
    act: (id: string, action: UserAction) => act.mutate({ id, action }),
    /** Toggle between admin and user, whichever the current role is not. */
    toggleRole: (user: AdminUser) => act.mutate({ id: user.id, action: user.role === 'ADMIN' ? 'demote' : 'promote' }),
    resetPassword: (id: string, password: string) => resetPassword.mutateAsync({ id, password }).then(() => true, () => false),
    update: (id: string, payload: UpdateUserPayload) => update.mutateAsync({ id, payload }).then(() => true, () => false),
    setEmailVerified: (id: string, verified: boolean) => verification.mutate({ id, verified }),
    busy: act.isPending || resetPassword.isPending || update.isPending || verification.isPending || remove.isPending,
    toggleActive: async (user: AdminUser) => {
      const deactivating = user.status === 'active';
      if (deactivating && !await confirmDialog({
        title: `Deactivate ${user.email}?`,
        description: 'This ends all active sessions and blocks access until the account is reactivated.',
        confirmLabel: 'Deactivate user',
        tone: 'danger',
      })) return;
      update.mutate({ id: user.id, payload: { status: deactivating ? 'inactive' : 'active' } });
    },
    create: (payload: CreateUserPayload) => create.mutate(payload),
    creating: create.isPending,
    createdPassword,
    clearCreatedPassword: () => setCreatedPassword(null),
    /** Deleting a user is not reversible, so it always asks first. */
    confirmRemove: async (user: AdminUser) => {
      if (await confirmDialog({ title: `Delete ${user.email}?`, description: 'The account and its sessions are removed.', confirmLabel: 'Delete user', tone: 'danger' })) remove.mutate(user.id);
    },
  };
}
