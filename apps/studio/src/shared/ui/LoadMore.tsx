'use client';

import { useLoadOnScroll } from '@/shared/hooks/useLoadOnScroll';
import { PageSizeSelect } from '@/shared/ui/Pager';

/**
 * Footer of a list that grows as it is scrolled: the next page is fetched when
 * this comes into view, and the button does the same for anyone who would
 * rather click (or whose list is too short to scroll).
 *
 * The cursor-paged sibling of {@link Pager}. Use it where "page 7 of 40" means
 * nothing because the list moves under the reader, as a log stream does.
 */
export function LoadMore({
  loaded,
  hasMore,
  loading,
  onLoadMore,
  pageSize,
  pageSizes,
  onPageSizeChange,
  label = 'items',
  moreLabel = 'Load more',
}: {
  /** How many are on screen, not how many exist. */
  loaded: number;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  pageSize: number;
  pageSizes: number[];
  onPageSizeChange: (size: number) => void;
  label?: string;
  moreLabel?: string;
}) {
  const sentinel = useLoadOnScroll<HTMLDivElement>(onLoadMore, hasMore && !loading);

  return (
    <div
      ref={sentinel}
      className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[11px]"
      style={{ color: 'var(--text-mute)' }}
    >
      <span className="tabular-nums">
        {loaded.toLocaleString()} {label}
        {hasMore ? '' : ', nothing further'}
      </span>
      <div className="flex items-center gap-2">
        <PageSizeSelect value={pageSize} sizes={pageSizes} onChange={onPageSizeChange} />
        {hasMore && (
          <button type="button" onClick={onLoadMore} disabled={loading} className="btn btn-ghost">
            {loading ? 'Loading…' : moreLabel}
          </button>
        )}
      </div>
    </div>
  );
}
