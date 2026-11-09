import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { usersApi } from '@/features/auth/api/users.api';
import type { ImpersonationSession } from '@/features/auth/types';
import { getErrorMessage } from '@/shared/lib/errors';
import { invalidateFor } from '@/shared/lib/invalidate';
import { useToast } from '@/shared/lib/toast';

/**
 * The impersonation session an operator holds on one user, and session
 * revocation, which ends that impersonation when it revokes its session.
 */
export function useImpersonation(userId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const [session, setSession] = useState<ImpersonationSession | null>(null);

  const start = useMutation({
    mutationFn: () => usersApi.impersonate(userId),
    onSuccess: data => {
      setSession(data);
      void invalidateFor(qc, 'user.changed');
    },
    onError: e => toast.push({ kind: 'error', title: 'Impersonation failed', message: getErrorMessage(e) }),
  });

  const stop = useMutation({
    mutationFn: (token: string) => usersApi.stopImpersonating(userId, token),
    onSuccess: () => {
      setSession(null);
      void invalidateFor(qc, 'session.revoked');
      toast.push({ kind: 'success', title: 'Impersonation ended' });
    },
    onError: e => toast.push({ kind: 'error', title: 'Could not end impersonation', message: getErrorMessage(e) }),
  });

  const revokeSession = useMutation({
    mutationFn: (sessionId: string) => usersApi.revokeSession(userId, sessionId),
    onSuccess: (_data, sessionId) => {
      if (session?.sessionId === sessionId) setSession(null);
      void invalidateFor(qc, 'session.revoked');
      toast.push({ kind: 'success', title: 'Session revoked' });
    },
    onError: e => toast.push({ kind: 'error', title: 'Revoke failed', message: getErrorMessage(e) }),
  });

  return { session, start, stop, revokeSession };
}
