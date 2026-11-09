import { ChevronLeft, ChevronRight } from 'lucide-react';
import Select from '@/shared/ui/Select';

const PAGE_SIZES = [25, 50, 100, 200];

function rangeLabel({ loaded, page, pageSize, total, totalEstimated }: { loaded: boolean; page: number; pageSize: number; total: number | undefined; totalEstimated: boolean }) {
  if (!loaded) return '-';
  return `${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total ?? 0)} of ${totalEstimated ? '~' : ''}${total ?? 0}`;
}

export function PagerBar({
  loaded,
  page,
  pageSize,
  total,
  totalEstimated,
  totalPages,
  showEditHint,
  onPageChange,
  onPageSizeChange,
}: {
  loaded: boolean;
  page: number;
  pageSize: number;
  total: number | undefined;
  totalEstimated: boolean;
  totalPages: number;
  showEditHint: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t hairline px-2 py-2.5 text-[11px] sm:px-4" style={{ color: 'var(--text-mute)' }}>
      <div className="flex items-center gap-3">
        <span className="tabular-nums">{rangeLabel({ loaded, page, pageSize, total, totalEstimated })}</span>
        <Select value={String(pageSize)} onChange={value => onPageSizeChange(Number(value))} ariaLabel="Rows per page" className="tabular-nums" style={{ fontSize: 11, padding: '4px 8px' }} options={PAGE_SIZES.map(size => ({ value: String(size), label: `${size} / page` }))} />
      </div>
      {showEditHint && (
        <span className="hidden lg:inline">
          Double-click a cell to edit · <kbd>Enter</kbd> next row · <kbd>Tab</kbd> next column
        </span>
      )}
      <div className="flex items-center gap-1">
        <button disabled={page <= 1} onClick={() => onPageChange(page - 1)} className="btn btn-ghost"><ChevronLeft size={12} /></button>
        <span className="px-2 tabular-nums">{page} / {totalPages}</span>
        <button disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} className="btn btn-ghost"><ChevronRight size={12} /></button>
      </div>
    </div>
  );
}
