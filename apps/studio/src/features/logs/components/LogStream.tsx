'use client';

import { Fragment, useState, type ReactNode, type Ref } from 'react';
import { ChevronRight } from 'lucide-react';
import { CodeBlock } from '@/shared/ui/CodeBlock';
import CopyButton from '@/shared/ui/CopyButton';
import { EmptyState } from '@/shared/ui/EmptyState';
import { SkeletonList } from '@/shared/ui/Skeleton';
import { LogField } from '@/features/logs/components/LogField';
import { baseLogColumns, httpDetails, type LogColumn } from '@/features/logs/lib/columns';
import { durationColor, methodColor, statusColor } from '@/features/logs/lib/http-line';
import { LEVEL_STYLE, type LogLike } from '@/features/logs/lib/log-stream';

/** The expanded body of one entry: its fields, then its message. Everything the
 *  server recorded is here regardless of which columns are on, so a line can be
 *  read in full without rearranging the table. */
function LogDetail<T extends LogLike>({
  entry,
  extraFields,
  children,
}: {
  entry: T;
  extraFields?: ReactNode;
  children?: ReactNode;
}) {
  const http = httpDetails(entry);

  return (
    <div className="border-t hairline px-4 py-3" style={{ background: 'var(--surface-2)' }}>
      <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
        {extraFields}
        <LogField label="Level" value={entry.level} tone={LEVEL_STYLE[entry.level].color} />
        <LogField label="Source" value={entry.source} />
        <LogField label="Timestamp" value={entry.at} />
        {http.method && <LogField label="Method" value={http.method} tone={methodColor(http.method)} />}
        {http.status !== undefined && <LogField label="Status" value={String(http.status)} tone={statusColor(http.status)} />}
        {http.durationMs !== undefined && (
          <LogField label="Duration" value={`${http.durationMs}ms`} tone={durationColor(http.durationMs)} />
        )}
        {http.path && <LogField label="Path" value={http.path} />}
        {http.ip && <LogField label="Client IP" value={http.ip} />}
        {http.userId && <LogField label="User" value={http.userId} />}
        {http.requestId && <LogField label="Request ID" value={http.requestId} />}
        {http.userAgent && <LogField label="User agent" value={http.userAgent} />}
      </div>

      <div className="mt-3">
        <CodeBlock
          value={entry.message}
          maxHeight={280}
          wrap
          copyable={false}
        />
      </div>
      {children}
    </div>
  );
}

export function LogStream<T extends LogLike>({
  entries,
  isLoading,
  keyOf,
  emptyTitle = 'No log lines match your filters.',
  onContextMenu,
  columns,
  renderDetailFields,
  renderDetailFooter,
  footer,
  scrollerRef,
}: {
  entries: T[];
  isLoading: boolean;
  keyOf: (entry: T) => string;
  emptyTitle?: string;
  onContextMenu: (event: React.MouseEvent, entry: T) => void;
  /** The visible columns, in order. Defaults to the shared set with the
   *  metadata columns off, which is what a screen without a picker wants. */
  columns?: LogColumn<T>[];
  /** Extra fields in the expanded body. */
  renderDetailFields?: (entry: T) => ReactNode;
  /** Anything below the message, such as a link to the owning project. */
  renderDetailFooter?: (entry: T) => ReactNode;
  /** Below the last row, inside the scroller: where a paged stream loads more. */
  footer?: ReactNode;
  /** The element that scrolls the rows, for a caller that has to move it. */
  scrollerRef?: Ref<HTMLDivElement>;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const shown = columns ?? baseLogColumns<T>().filter(column => column.defaultOn || column.required);

  return (
    <div className="card overflow-hidden">
      <div ref={scrollerRef} className="mono max-h-150 overflow-auto text-[12px]">
        {/* Column captions, inside the scroller so they share its scrollbar
            gutter with the rows and stay put while the stream is scrolled.
            Outside it they sat a scrollbar's width off from their own column.
            Hidden on a phone, where the message wraps under the other cells
            and there is no column left for a caption to sit over. */}
        <div
          className="sticky top-0 z-10 hidden items-center gap-3 sm:flex border-b hairline py-1.5 pl-4 pr-12 text-[10px] uppercase tracking-wider"
          style={{ background: 'var(--surface-2)', color: 'var(--text-mute)' }}
        >
          <span className="w-[11px] shrink-0" />
          {shown.map(column => (
            <span key={column.key} className={column.width ? `${column.width} shrink-0` : 'min-w-0 flex-1'}>
              {column.label}
            </span>
          ))}
        </div>

        {isLoading && <SkeletonList rows={8} height={20} className="p-3" />}

        {entries.map(entry => {
          const key = keyOf(entry);
          const style = LEVEL_STYLE[entry.level];
          const open = expanded === key;

          return (
            // `content-visibility` lets the browser skip laying out and painting
            // rows scrolled out of view, which is most of them once a few pages
            // are loaded. `auto` remembers each row's last height, expanded or not,
            // so the scrollbar does not jump as rows come back into view.
            <div
              key={key}
              className="group border-b hairline [content-visibility:auto] [contain-intrinsic-size:auto_33px]"
              onContextMenu={event => onContextMenu(event, entry)}
              style={{
                // A left rail in the level colour, so a run of errors is visible
                // as a block from across the room. Info stays unmarked.
                boxShadow: entry.level === 'info' ? undefined : `inset 2px 0 ${style.color}`,
                background: open ? 'var(--surface-2)' : undefined,
              }}
            >
              <div className="relative flex items-start hover:bg-(--hover)">
                {/* On a phone the fixed cells alone fill the row, which left
                    the message a sliver at the right edge, one character wide
                    once expanded. There it wraps onto a line of its own. */}
                <button
                  onClick={() => setExpanded(open ? null : key)}
                  className="flex min-w-0 flex-1 flex-wrap items-start gap-x-3 gap-y-1 py-1.75 pl-4 pr-3 text-left sm:flex-nowrap sm:pr-12"
                >
                  <ChevronRight
                    size={11}
                    style={{
                      color: 'var(--text-mute)',
                      transform: open ? 'rotate(90deg)' : undefined,
                      transition: 'transform 0.15s',
                      flexShrink: 0,
                      marginTop: 3,
                    }}
                  />
                  {shown.map(column => (
                    <Fragment key={column.key}>{column.render(entry, open)}</Fragment>
                  ))}
                </button>
                {/* An explicit copy button: right-click alone is undiscoverable. */}
                <CopyButton
                  value={JSON.stringify(entry, null, 2)}
                  title="Copy this entry as JSON"
                  className="btn btn-ghost absolute right-2 top-1 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                />
              </div>

              {open && (
                <LogDetail entry={entry} extraFields={renderDetailFields?.(entry)}>
                  {renderDetailFooter?.(entry)}
                </LogDetail>
              )}
            </div>
          );
        })}

        {footer}

        {!isLoading && entries.length === 0 && <EmptyState size="md" mascot="log-inspector" title={emptyTitle} />}
      </div>
    </div>
  );
}
