'use client';

import type { ReactNode } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { EmptyState } from '@/shared/ui/EmptyState';
import { SkeletonList } from '@/shared/ui/Skeleton';
import { getErrorMessage } from '@/shared/lib/errors';
import { formatRelativeTime } from '@/shared/lib/format';

/**
 * Loading, failed, empty, stale and loaded, told apart in one place.
 *
 * Most screens handled `isLoading` and `data`, then rendered `data ?? []`. A
 * request that failed therefore looked exactly like a project with nothing in
 * it: "No active sessions", "No cron jobs yet", "Collecting samples". The
 * provider raises a toast for the first failure of a query with no data, but a
 * toast is gone in seconds and the misleading sentence stays on screen; and a
 * refetch that fails over data already displayed raises nothing at all, so the
 * numbers silently stop moving.
 *
 * `lastUpdated` is what makes the stale case honest: the page keeps showing the
 * last good answer and says when it was good.
 */

/** The parts of a react-query result this needs. Structural, so any query fits. */
export interface QueryLike<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isFetching?: boolean;
  dataUpdatedAt?: number;
  refetch?: () => unknown;
}

export function QueryState<T>({
  query,
  isEmpty,
  empty,
  skeletonRows = 3,
  skeletonClassName = 'card p-4',
  errorTitle = 'Could not load this',
  children,
}: {
  query: QueryLike<T>;
  /** Defaults to "an empty array", the shape most of these queries return. */
  isEmpty?: (data: T) => boolean;
  /** Rendered when the request succeeded and there is genuinely nothing. */
  empty?: ReactNode;
  skeletonRows?: number;
  skeletonClassName?: string;
  errorTitle?: string;
  children: (data: T) => ReactNode;
}) {
  const { data, isLoading, isError, error } = query;

  if (isLoading && data === undefined) {
    return <SkeletonList rows={skeletonRows} className={skeletonClassName} />;
  }

  // Failed with nothing to fall back on: say so, never show an empty state.
  if (isError && data === undefined) {
    return <QueryFailure title={errorTitle} error={error} onRetry={query.refetch} />;
  }

  if (data === undefined) return null;

  const blank = isEmpty ? isEmpty(data) : Array.isArray(data) && data.length === 0;

  return (
    <>
      {/* Failed over data we already had: keep the data, flag it as old. */}
      {isError && <StaleNotice error={error} at={query.dataUpdatedAt} onRetry={query.refetch} />}
      {blank && empty ? empty : children(data)}
    </>
  );
}

/** A request that failed with nothing to show. Persistent, unlike a toast. */
export function QueryFailure({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: unknown;
  onRetry?: () => unknown;
}) {
  return (
    <div className="card">
      <EmptyState
        size="md"
        icon={AlertCircle}
        title={title}
        description={<span className="mono text-[12px]">{getErrorMessage(error)}</span>}
        action={
          onRetry ? (
            <button type="button" className="btn" onClick={() => onRetry()}>
              <RefreshCw size={12} /> Try again
            </button>
          ) : undefined
        }
      />
    </div>
  );
}

/** Data on screen is the last good answer, and the newest attempt failed. */
export function StaleNotice({
  error,
  at,
  onRetry,
}: {
  error: unknown;
  at?: number;
  onRetry?: () => unknown;
}) {
  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-3 border px-4 py-2.5"
      style={{
        borderColor: 'color-mix(in srgb, var(--amber) 42%, transparent)',
        background: 'color-mix(in srgb, var(--amber) 10%, var(--surface))',
        borderRadius: 'var(--radius-md)',
      }}
      role="status"
    >
      <AlertCircle size={15} style={{ color: 'var(--amber)', flexShrink: 0 }} />
      <span className="text-[12.5px]">
        Showing the last result from{' '}
        <strong>{at ? formatRelativeTime(new Date(at).toISOString()) : 'earlier'}</strong>. The latest refresh
        failed: <span className="mono">{getErrorMessage(error)}</span>
      </span>
      {onRetry && (
        <button type="button" className="btn ml-auto" onClick={() => onRetry()}>
          <RefreshCw size={12} /> Retry
        </button>
      )}
    </div>
  );
}
