import { useQuery } from '@tanstack/react-query';
import { keepPreviousFor } from '@/shared/lib/query';
import { logsApi } from '@/features/logs/api/logs.api';
import type { RangeKey } from '@/shared/lib/range';

/** Returns `{ samples, coverage }`: the coverage is what lets a page say when
 *  the buffer holds less than the selected range. */
export function useMetricsTimeseries(range: RangeKey) {
  return useQuery({
    // Keep the previous result on screen while the new selection loads.
    placeholderData: keepPreviousFor(range),
    queryKey: ['metrics-timeseries', range],
    queryFn: () => logsApi.metricsTimeseries(range),
    refetchInterval: 10_000,
  });
}

export function useStats() {
  return useQuery({
    queryKey: ['stats'],
    queryFn: logsApi.stats,
    staleTime: 15_000,
  });
}
