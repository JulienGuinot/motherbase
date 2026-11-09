import { useQuery } from '@tanstack/react-query';
import { getSettings, getAuthStatus } from '@/shared/lib/settings';

export function useAuthStatus() {
  return useQuery({ queryKey: ['auth-status'], queryFn: getAuthStatus });
}

export function useAuthSetting(key: string) {
  return useQuery({ queryKey: ['settings', key], queryFn: () => getSettings(key) });
}
