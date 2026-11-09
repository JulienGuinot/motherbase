import { useQuery, useQueryClient } from '@tanstack/react-query';
import { twoFactorApi } from '@/features/auth/api/twoFactor.api';

const TWO_FACTOR_STATUS_QUERY_KEY = ['console', 'two-factor-status'] as const;

type TwoFactorStatus = Awaited<ReturnType<typeof twoFactorApi.status>>;

export function useTwoFactorStatus() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: TWO_FACTOR_STATUS_QUERY_KEY,
    queryFn: twoFactorApi.status,
    retry: false,
  });

  function setEnabled(enabled: boolean) {
    queryClient.setQueryData<TwoFactorStatus>(TWO_FACTOR_STATUS_QUERY_KEY, current => ({
      email: current?.email,
      enabled,
    }));
  }

  return { enabled: status.isError ? false : status.data?.enabled ?? null, setEnabled };
}
