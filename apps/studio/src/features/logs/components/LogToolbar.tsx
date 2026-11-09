'use client';

import { useMemo, type ReactNode } from 'react';
import { Pause, Play, RefreshCw, Search, X } from 'lucide-react';
import CopyButton from '@/shared/ui/CopyButton';
import ExportButton from '@/shared/ui/ExportButton';
import RangePicker from '@/shared/ui/RangePicker';
import { LOG_RANGE_MS, type LogRangeKey } from '@/shared/lib/range';
import ColumnPicker from '@/features/logs/components/ColumnPicker';
import FacetFilter from '@/features/logs/components/FacetFilter';
import type { LogColumnsState } from '@/features/logs/lib/columns';
import type { useLogStream } from '@/features/logs/hooks/useLogStream';
import type { LogFacet, LogLike } from '@/features/logs/lib/log-stream';

// The export carries every recorded field, not only the visible columns: a CSV
// pulled into a ticket is read away from this screen's layout.
const EXPORT_COLUMNS = [
  { key: 'at', label: 'Timestamp' },
  { key: 'level', label: 'Level' },
  { key: 'source', label: 'Source' },
  { key: 'message', label: 'Message' },
  { key: 'method', label: 'Method' },
  { key: 'path', label: 'Path' },
  { key: 'status', label: 'Status' },
  { key: 'durationMs', label: 'Duration (ms)' },
  { key: 'ip', label: 'Client IP' },
  { key: 'userAgent', label: 'User agent' },
  { key: 'userId', label: 'User' },
  { key: 'requestId', label: 'Request ID' },
  { key: 'id', label: 'ID' },
];

/** Search, facets, range, pause and export. Extra controls slot in as children. */
export function LogToolbar<T extends LogLike>({
  stream,
  facets,
  exportName,
  onRefresh,
  columns,
  ranges = LOG_RANGE_MS,
  children,
}: {
  stream: ReturnType<typeof useLogStream<T>>;
  facets: LogFacet<T>[];
  exportName: string;
  onRefresh: () => void;
  /** Column visibility, when the screen lets the operator choose. */
  columns?: LogColumnsState<T>;
  /** Selectable windows. A stream with no stored history offers fewer. */
  ranges?: Partial<Record<LogRangeKey, number>>;
  children?: ReactNode;
}) {
  // Pasting the current view into a ticket is the most common thing anyone does
  // with this screen, and a CSV download is the wrong shape for it.
  const asJson = useMemo(() => JSON.stringify(stream.filtered, null, 2), [stream.filtered]);

  return (
    <div className="card">
      {/* Two bands rather than one wrapping row of thirteen controls: what
          window am I looking at, then what am I filtering it by. */}
      <div className="flex flex-wrap items-center gap-2 p-2.5">
        <div
          className="flex min-w-[220px] flex-1 items-center gap-2 border hairline-strong px-3 py-1.5"
          style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
        >
          <Search size={12} style={{ color: 'var(--text-mute)' }} />
          <input
            value={stream.query}
            onChange={e => stream.setQuery(e.target.value)}
            placeholder="Search messages…"
            className="w-full bg-transparent text-[13px] outline-none placeholder:opacity-50"
          />
          {stream.query && (
            <button onClick={() => stream.setQuery('')} title="Clear search" style={{ color: 'var(--text-mute)' }}>
              <X size={12} />
            </button>
          )}
        </div>

        <RangePicker value={stream.range} onChange={stream.setRange} ranges={ranges} />

        <button onClick={stream.togglePaused} className="btn" title={stream.paused ? 'Resume the stream' : 'Pause the stream'}>
          {stream.paused ? (
            <>
              <Play size={12} /> Resume
            </>
          ) : (
            <>
              <Pause size={12} /> Pause
            </>
          )}
        </button>

        <button onClick={onRefresh} className="btn btn-ghost" title="Refresh now" aria-label="Refresh now">
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t hairline p-2.5">
        <FacetFilter
          label="level"
          options={stream.optionsFor('level')}
          selected={stream.levels}
          onToggle={stream.toggleLevel}
          onClear={stream.clearLevels}
        />

        {facets.map(facet => (
          <FacetFilter
            key={facet.key}
            label={facet.label}
            options={stream.optionsFor(facet.key)}
            selected={stream.selectedFor(facet.key)}
            onToggle={value => stream.toggleFacet(facet.key, value)}
            onClear={() => stream.clearFacet(facet.key)}
          />
        ))}

        {stream.hasFilters && (
          <button onClick={stream.clearAll} className="btn btn-ghost" title="Clear every filter">
            <X size={12} /> Clear
          </button>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {columns && <ColumnPicker columns={columns} />}
          {children}
          <CopyButton
            value={asJson}
            label={`Copy ${stream.filtered.length}`}
            title="Copy the filtered lines as JSON"
            className="btn btn-ghost"
          />
          <ExportButton filename={exportName} columns={EXPORT_COLUMNS} rows={stream.filtered} className="btn btn-ghost" />
        </div>
      </div>
    </div>
  );
}
