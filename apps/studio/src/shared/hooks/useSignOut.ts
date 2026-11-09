import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { auth } from '@/shared/lib/auth';
import { activeOrg } from '@/shared/lib/org';

/**
 * The one way to sign out. Clearing only the token left the previous
 * operator's cached queries in memory and their org id in localStorage, both
 * of which the next sign-in on this browser would pick up.
 */
export function useSignOut() {
  const router = useRouter();
  const queryClient = useQueryClient();
  return useCallback(() => {
    auth.clear();
    queryClient.clear();
    activeOrg.set(null);
    router.push('/login');
  }, [queryClient, router]);
}
