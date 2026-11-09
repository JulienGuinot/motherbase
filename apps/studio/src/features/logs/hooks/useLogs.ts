import { useMemo } from 'react';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { logsApi } from '@/features/logs/api/logs.api';
import { LOG_RANGE_MS, type LogRangeKey } from '@/shared/lib/range';
import type { LogEntry, LogPage, LogQueryFilters } from '@/features/logs/types';

/** Offered by the stream's footer. The server caps a page at 5000 (MAX_LOG_LIMIT). */
export const LOG_PAGE_SIZES = [100, 250, 500, 1000];
export const DEFAULT_LOG_PAGE_SIZE = 500;

type LogPages = InfiniteData<LogPage, string | undefined>;

/** Every loaded line, oldest first like each page: pages run newest to oldest. */
export function flattenLogPages(pages: LogPage[]): LogEntry[] {
  return pages.toReversed().flatMap(page => page.logs);
}

/**
 * The visible range AND the active filters decide what is fetched.
 *
 * History past the server's in-memory ring buffer lives in
 * `platform.request_logs` and is only returned when asked for by `since`. The
 * filters have to travel too: they used to be applied in the browser, to a list
 * the server had already cut to the newest 1000 or 5000 lines. An error with a
 * thousand info lines after it was simply not in that slice, so filtering for
 * "error" returned nothing for a line the retention had kept. The endpoint has
 * accepted `level`, `source` and `q` the whole time.
 */
export function useLogs(
  paused: boolean,
  range: LogRangeKey = '1h',
  filters: LogQueryFilters = {},
  pageSize = DEFAULT_LOG_PAGE_SIZE,
) {
  const qc = useQueryClient();
  const rangeMs = LOG_RANGE_MS[range];
  const levels = [...(filters.levels ?? [])].sort();
  const sources = [...(filters.sources ?? [])].sort();
  const q = filters.q?.trim() ?? '';
  const request = {
    service: filters.service ?? '',
    status: filters.status?.trim() ?? '',
    method: filters.method ?? '',
    path: filters.path?.trim() ?? '',
    user: filters.user?.trim() ?? '',
  };
  // Sorted and normalised, so re-selecting the same filters in another order
  // is a cache hit rather than a second identical request.
  const queryKey = ['logs', range, levels, sources, q, request, pageSize];

  const query = useInfiniteQuery({
    queryKey,
    // The first page is the newest lines; each further one starts below the
    // oldest line already loaded, so scrolling down walks back in time.
    queryFn: ({ pageParam }) =>
      logsApi.logs({
        since: Date.now() - rangeMs,
        limit: pageSize,
        before: pageParam,
        levels,
        sources,
        q,
        ...request,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.nextCursor ?? undefined,
    // Only the head is live. A poll refetches every loaded page in turn, which
    // with ten pages scrolled in would be ten requests every two seconds.
    refetchInterval: current => (paused || (current.state.data?.pages.length ?? 0) > 1 ? false : 2000),
    // Switching range or filters must not blank the stream while it loads.
    placeholderData: previous => previous,
  });

  const pages = query.data?.pages;
  const entries = useMemo(() => (pages ? flattenLogPages(pages) : []), [pages]);

  return {
    query,
    entries,
    /** What the server reported about storage, from the newest page. */
    head: pages?.[0],
    /** Older pages are loaded, so the stream has stopped following new lines. */
    browsingHistory: (pages?.length ?? 0) > 1,
    loadOlder: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    /** Drop the older pages, which is what lets the head poll again. */
    backToLive: () => {
      qc.setQueryData<LogPages>(queryKey, data => data && {
        pages: data.pages.slice(0, 1),
        pageParams: data.pageParams.slice(0, 1),
      });
      void qc.invalidateQueries({ queryKey, exact: true });
    },
  };
}
