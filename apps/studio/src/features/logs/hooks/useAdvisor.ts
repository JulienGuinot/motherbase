import { useQuery } from '@tanstack/react-query';
import { logsApi } from '@/features/logs/api/logs.api';
import type { Category } from '@/features/logs/types';

/**
 * @param range the period the caller is charting. The route tables used to be
 * summarized over a hard-coded hour whatever the page's range picker said, so
 * a 15-minute chart sat above hour-long route totals.
 */
export function useShield(range?: string) {
  return useQuery({
    queryKey: ['shield', range ?? 'default'],
    queryFn: () => logsApi.shield(range),
    refetchInterval: 10_000,
  });
}

export function usePerformance(tab: Category) {
  return useQuery({
    queryKey: ['performance'],
    queryFn: logsApi.performance,
    enabled: tab === 'performance',
    refetchInterval: tab === 'performance' ? 10_000 : false,
  });
}
