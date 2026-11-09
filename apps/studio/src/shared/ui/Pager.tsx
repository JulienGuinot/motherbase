'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import Select from '@/shared/ui/Select';

/** The "N / page" picker, shared by the numbered pager and the load-more footer. */
export function PageSizeSelect({
  value,
  sizes,
  onChange,
}: {
  value: number;
  sizes: number[];
  onChange: (size: number) => void;
}) {
  return (
    <Select
      value={String(value)}
      onChange={next => onChange(Number(next))}
      ariaLabel="Per page"
      className="tabular-nums"
      style={{ fontSize: 11, padding: '4px 8px' }}
      options={sizes.map(size => ({ value: String(size), label: `${size} / page` }))}
    />
  );
}

/**
 * Page controls for a server-paginated list.
 *
 * Extracted from the table editor's own footer so the storage browser can have
 * the same one. The browser had no pager at all: the server defaults to 25 rows
 * and nothing ever asked for a second page, so an object past the first page
 * could not be reached, searched or filtered to.
 */
export function Pager({
  page,
  pageCount,
  pageSize,
  total,
  pageSizes = [25, 50, 100],
  onPageChange,
  onPageSizeChange,
  label = 'items',
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  /** Everything the current filters match, not the length of this page. */
  total: number;
  pageSizes?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  label?: string;
}) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 px-1 py-2 text-[11px]"
      style={{ color: 'var(--text-mute)' }}
    >
      <div className="flex items-center gap-3">
        <span className="tabular-nums">
          {first}-{last} of {total.toLocaleString()} {label}
        </span>
        <PageSizeSelect value={pageSize} sizes={pageSizes} onChange={onPageSizeChange} />
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="btn btn-ghost"
          aria-label="Previous page"
        >
          <ChevronLeft size={12} />
        </button>
        <span className="px-2 tabular-nums">
          {page} / {pageCount}
        </span>
        <button
          type="button"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
          className="btn btn-ghost"
          aria-label="Next page"
        >
          <ChevronRight size={12} />
        </button>
      </div>
    </div>
  );
}
