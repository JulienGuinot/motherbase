import { useQuery } from '@tanstack/react-query';
import { projectsApi } from '@/features/projects/api/projects.api';
import { platform } from '@/shared/lib/api';

export function useConnectInfo() {
  return useQuery({ queryKey: ['connect-info'], queryFn: projectsApi.connectInfo });
}

export function useConnectDns(projectId: string | null) {
  return useQuery({
    queryKey: ['connect-dns', projectId],
    enabled: Boolean(projectId),
    queryFn: async () => (await platform.projectDns(projectId!)).checks,
  });
}

export function useOverviewStats() {
  return useQuery({
    queryKey: ['stats'],
    queryFn: projectsApi.stats,
    refetchInterval: 4000,
  });
}

/**
 * @param windowMs the period the page labels these lines with. It used to ask
 * for "the last 200 lines" with no bound and call them "last 60m", so on a
 * quiet project a week-old error was counted as an error in the last hour.
 */
export function useOverviewLogs(windowMs: number) {
  return useQuery({
    queryKey: ['logs', 'overview', windowMs],
    // Recomputed per fetch so the window slides with the clock rather than
    // being frozen at the moment the component mounted.
    queryFn: () => projectsApi.logs(Date.now() - windowMs),
    refetchInterval: 4000,
  });
}

export function useIntegrations() {
  return useQuery({
    queryKey: ['integrations'],
    queryFn: projectsApi.integrations,
  });
}

export function usePlatformDns() {
  return useQuery({ queryKey: ['platform-dns'], queryFn: platform.dns, refetchInterval: 15000 });
}

export function usePlatformMetrics() {
  return useQuery({
    queryKey: ['platform-metrics'],
    queryFn: platform.metrics,
    refetchInterval: 5000,
  });
}

/** Disk sizes move slowly and the server caches volume sizing for minutes. */
export function usePlatformDisk() {
  return useQuery({ queryKey: ['platform-disk'], queryFn: platform.disk, refetchInterval: 60_000 });
}

export function usePlatformSettings() {
  return useQuery({ queryKey: ['platform-settings'], queryFn: platform.settings });
}
