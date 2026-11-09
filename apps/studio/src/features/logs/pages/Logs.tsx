'use client';

import { useMemo, useReducer, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bookmark, Database, Plus, Trash2 } from 'lucide-react';
import { PageShell } from '@/shared/ui/PageHeader';
import { Popover } from '@/shared/ui/Popover';
import { promptDialog } from '@/shared/ui/ConfirmDialog';
import { useContextMenu } from '@/shared/hooks/useContextMenu';
import { useDebounced } from '@/shared/hooks/useDebounced';
import { usePersistentState } from '@/shared/hooks/usePersistentState';
import { useToast } from '@/shared/lib/toast';
import { LogContextMenu } from '@/features/logs/components/LogContextMenu';
import { LogField } from '@/features/logs/components/LogField';
import { LogStream } from '@/features/logs/components/LogStream';
import { LogStreamHeader } from '@/features/logs/components/LogStreamHeader';
import { LogToolbar } from '@/features/logs/components/LogToolbar';
import { DEFAULT_LOG_PAGE_SIZE, LOG_PAGE_SIZES, useLogs } from '@/features/logs/hooks/useLogs';
import { useLogFilters, useLogStream } from '@/features/logs/hooks/useLogStream';
import { useSavedViews } from '@/features/logs/lib/logViews';
import { baseLogColumns, useLogColumns } from '@/features/logs/lib/columns';
import SettingsForm from '@/shared/ui/SettingsForm';
import { LoadMore } from '@/shared/ui/LoadMore';
import { LOG_RANGE_MS, type LogRangeKey } from '@/shared/lib/range';
import { LOG_SOURCES, type LogFacet } from '@/features/logs/lib/log-stream';
import { logSource } from '@/features/logs/lib/log-sources';
import { LogSourceSidebar, type LogSelection } from '@/features/logs/components/LogSourceSidebar';
import { LogRequestFilters, isValidStatusFilter } from '@/features/logs/components/LogRequestFilters';
import { LogQueryExplorer } from '@/features/logs/components/LogQueryExplorer';
import { useContent } from '@/shared/hooks/useContent';
import type { LogEntry, LogRequestFilters as RequestFilters } from '@/features/logs/types';

const FACETS: LogFacet<LogEntry>[] = [
  { key: 'source', label: 'source', of: entry => entry.source, values: LOG_SOURCES },
];

/** Named filter sets, saved locally so an investigation can be resumed. */
function SavedViews({
  stream,
}: {
  stream: ReturnType<typeof useLogStream<LogEntry>>;
}) {
  const toast = useToast();
  const { views, save, remove } = useSavedViews();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);

  const saveCurrent = async () => {
    const name = await promptDialog({ title: 'Save view', placeholder: 'Errors from auth', confirmLabel: 'Save view' });
    if (!name) return;
    save({
      name,
      levels: [...stream.levels],
      sources: [...stream.selectedFor('source')],
      query: stream.query,
      range: stream.range,
    });
    toast.push({ kind: 'success', title: 'View saved' });
  };

  return (
    <>
      <button ref={button} onClick={() => setOpen(o => !o)} className="btn">
        <Bookmark size={12} /> Views{views.length ? ` (${views.length})` : ''}
      </button>

      {open && (
        <Popover anchor={button} onClose={close} width={230} align="end">
          <button
            onClick={() => {
              void saveCurrent();
              close();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-[12px]"
            style={{ color: 'var(--accent)' }}
          >
            <Plus size={13} /> Save current filters
          </button>

          {views.length > 0 && <div className="my-1 border-t hairline" />}

          {views.map(view => (
            <div key={view.id} className="row-host flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-[var(--hover)]">
              <button
                onClick={() => {
                  stream.applyFilters({
                    levels: view.levels,
                    facets: { source: view.sources },
                    query: view.query,
                    range: view.range,
                  });
                  close();
                }}
                className="flex-1 truncate text-left"
                style={{ color: 'var(--text-dim)' }}
                title={view.name}
              >
                {view.name}
              </button>
              <button onClick={() => remove(view.id)} className="row-actions" style={{ color: 'var(--danger)' }} title="Delete view">
                <Trash2 size={12} />
              </button>
            </div>
          ))}

          {views.length === 0 && (
            <p className="px-3 py-2 text-[11px]" style={{ color: 'var(--text-mute)' }}>
              No saved views yet.
            </p>
          )}
        </Popover>
      )}
    </>
  );
}

/** `?source=auth` opens that source, `?source=query` the query mode. */
function initialSelection(): LogSelection {
  if (typeof window === 'undefined') return { mode: 'stream', service: null };
  const source = new URLSearchParams(window.location.search).get('source');
  if (source === 'query') return { mode: 'query', savedId: null };
  return { mode: 'stream', service: logSource(source)?.id ?? null };
}

export default function Logs() {
  const qc = useQueryClient();
  const menu = useContextMenu<LogEntry>();
  const [selection, setSelection] = useState<LogSelection>(initialSelection);
  const [requestFilters, setRequestFilters] = useState<RequestFilters>({});
  const savedQueries = useContent('log_sql');

  const [paused, togglePaused] = useReducer(current => !current, false);
  const [range, setRange] = useState<LogRangeKey>('1h');
  const [pageSize, setPageSize] = usePersistentState('console.logPageSize', DEFAULT_LOG_PAGE_SIZE);
  const streamScroller = useRef<HTMLDivElement>(null);
  const [showRetention, toggleRetention] = useReducer(current => !current, false);

  // Owned here, not inside useLogStream: the fetch needs them, because the
  // server has to filter before it applies its row limit. Filtering the fetched
  // page in the browser could not reach a matching line older than the cut.
  const filters = useLogFilters();
  // The text box stays instant; only the request behind it waits.
  const debouncedQuery = useDebounced(filters.query, 300);
  const debouncedRequest = useDebounced(requestFilters, 300);
  const service = selection.mode === 'stream' ? selection.service : null;
  const logs = useLogs(paused || selection.mode === 'query', range, {
    levels: [...filters.levels],
    sources: [...(filters.selected.source ?? [])],
    q: debouncedQuery,
    service: service ?? undefined,
    // A half-typed status (`5x`) would be refused by the server; wait for a whole one.
    ...(isValidStatusFilter(debouncedRequest.status) ? debouncedRequest : { ...debouncedRequest, status: undefined }),
  }, pageSize);
  const logsQuery = logs.query;
  const page = logs.head;
  const entries = logs.entries;

  const columns = useLogColumns<LogEntry>('console.logColumns', useMemo(() => baseLogColumns<LogEntry>(), []));

  const stream = useLogStream<LogEntry>({
    entries,
    updatedAt: logsQuery.dataUpdatedAt,
    facets: FACETS,
    // The metadata is searchable too: chasing one caller means typing its IP.
    search: entry => [entry.message, entry.source, entry.ip, entry.userAgent, entry.userId, entry.requestId]
      .filter((value): value is string => Boolean(value)),
    paused,
    onTogglePaused: togglePaused,
    range,
    onRangeChange: setRange,
    filters,
  });

  // A range wider than what is stored comes back short, and a stream that
  // simply looks quiet is indistinguishable from one that is truncated.
  const oldest = page?.oldestAvailable ? Date.parse(page.oldestAvailable) : null;
  // Against the fetch time, not the clock: the same input must give the same
  // render, and the fetch is what the window was computed from anyway.
  const truncated = Boolean(
    oldest && oldest > logsQuery.dataUpdatedAt - LOG_RANGE_MS[range] + 60_000 && entries.length > 0
  );

  const source = logSource(service);
  const openSaved = selection.mode === 'query' && selection.savedId
    ? savedQueries.items.find(item => item.id === selection.savedId) ?? null
    : null;

  return (
    <PageShell width="wide">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <LogSourceSidebar selection={selection} savedQueries={savedQueries.items} onSelect={setSelection} />
        {selection.mode === 'query' ? (
          <LogQueryExplorer
            key={openSaved?.id ?? 'scratch'}
            saved={openSaved}
            queries={savedQueries}
            persisted={page?.persisted ?? true}
            onSaved={id => setSelection({ mode: 'query', savedId: id })}
          />
        ) : (
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <LogStreamHeader
              paused={stream.paused}
              shown={stream.filtered.length}
              total={stream.windowed.length}
              range={stream.range}
              description={source
                ? `${source.label}: ${source.description} Auto-refresh every 2s.`
                : 'API traffic, SQL, auth, storage, edge functions, realtime, jobs and webhooks. Auto-refresh every 2s.'}
              counts={stream.counts}
              levelBuckets={stream.levelBuckets}
            />

            {page && !page.persisted && (
              <div className="card p-3 text-[12px]" style={{ color: 'var(--amber)' }}>
                Log storage is off, so only the in-memory buffer is available: history is capped by
                CONSOLE_LOG_BUFFER_SIZE and lost on restart. Turn it on under <em>Retention</em> below.
              </div>
            )}

            {page?.persisted && truncated && (
              <div className="card p-3 text-[12px]" style={{ color: 'var(--text-dim)' }}>
                Oldest line available: {new Date(oldest!).toLocaleString()}
                {page.retentionDays ? ` · lines are kept for ${page.retentionDays} day${page.retentionDays === 1 ? '' : 's'}.` : '.'}
              </div>
            )}

            {/* The poll stops once older pages are in (see useLogs), and a stream
                that stopped moving must say so rather than look quiet. */}
            {logs.browsingHistory && !paused && (
              <div
                className="card flex flex-wrap items-center justify-between gap-2 p-3 text-[12px]"
                style={{ color: 'var(--text-dim)' }}
              >
                <span>Older lines are loaded, so new ones are not streaming in.</span>
                {/* To the top first: left at the bottom, the footer would still be
                    in view once the older pages are gone and fetch them straight back. */}
                <button
                  onClick={() => {
                    streamScroller.current?.scrollTo({ top: 0 });
                    logs.backToLive();
                  }}
                  className="btn btn-ghost"
                >
                  Back to live
                </button>
              </div>
            )}

            <LogToolbar
              stream={stream}
              facets={FACETS}
              columns={columns}
              exportName={`logs-${logsQuery.dataUpdatedAt || 'export'}`}
              onRefresh={() => qc.invalidateQueries({ queryKey: ['logs'] })}
            >
              <SavedViews stream={stream} />
              <button onClick={toggleRetention} className="btn btn-ghost" title="History and retention">
                <Database size={12} /> Retention
              </button>
            </LogToolbar>

            <LogRequestFilters value={requestFilters} onChange={setRequestFilters} />

            {showRetention && (
              <div className="card space-y-3 p-4">
                <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                  How far back this screen can look. Lines are stored in
                  <span className="mono"> platform.request_logs</span> and pruned by the data-retention job.
                </p>
                <SettingsForm group="logs.retention" onSaved={() => qc.invalidateQueries({ queryKey: ['logs'] })} />
              </div>
            )}

            <LogStream
              entries={stream.filtered}
              isLoading={logsQuery.isLoading}
              keyOf={entry => String(entry.id)}
              columns={columns.visible}
              onContextMenu={menu.onContextMenu}
              scrollerRef={streamScroller}
              footer={entries.length > 0 && (
                <LoadMore
                  loaded={entries.length}
                  hasMore={logsQuery.hasNextPage}
                  loading={logsQuery.isFetchingNextPage}
                  onLoadMore={logs.loadOlder}
                  pageSize={pageSize}
                  pageSizes={LOG_PAGE_SIZES}
                  onPageSizeChange={setPageSize}
                  label="lines loaded"
                  moreLabel="Load older"
                />
              )}
              renderDetailFields={entry => (
                <>
                  <LogField label="ID" value={String(entry.id)} />
                  {entry.service && <LogField label="Service" value={logSource(entry.service)?.label ?? entry.service} />}
                </>
              )}
            />
          </div>
        )}
      </div>

      {menu.menu && (
        <LogContextMenu
          x={menu.menu.x}
          y={menu.menu.y}
          entry={menu.menu.data}
          entryId={String(menu.menu.data.id)}
          hasFilters={stream.hasFilters}
          facetActions={[
            {
              label: `Filter by source: ${menu.menu.data.source}`,
              run: () => stream.toggleFacet('source', menu.menu!.data.source),
            },
          ]}
          onClose={menu.close}
          onFilterLevel={() => stream.toggleLevel(menu.menu!.data.level)}
          onClearFilters={stream.clearAll}
        />
      )}
    </PageShell>
  );
}
