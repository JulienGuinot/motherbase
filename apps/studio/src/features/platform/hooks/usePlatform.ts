import { useQuery } from '@tanstack/react-query';
import { platformApi } from '@/features/platform/api/platform.api';

export function useBackups() {
  return useQuery({ queryKey: ['backups'], queryFn: platformApi.backups });
}

export function useSession() {
  return useQuery({ queryKey: ['session'], queryFn: platformApi.session });
}

export function usePlatformConnectInfo() {
  return useQuery({ queryKey: ['connect-info'], queryFn: platformApi.connectInfo });
}
