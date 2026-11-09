'use client';

import { useMemo, useState } from 'react';
import { LOG_RANGE_MS, type LogRangeKey } from '@/shared/lib/range';
import {
  bucketsByLevel,
  countByLevel,
  entriesSince,
  facetOptions,
  filterEntries,
  levelOptions,
  type FacetOption,
  type LogFacet,
  type LogLike,
} from '@/features/logs/lib/log-stream';

/**
 * Level, facet and text filter state, liftable out of {@link useLogStream}.
 *
 * The project stream sends these to the server so filtering happens before the
 * row limit, which means the page has to own them: the query that produces
 * `entries` needs them, and `entries` is what useLogStream consumes. Streams
 * that filter purely in the browser (the fleet view) can leave it alone and get
 * the internal state.
 */
export function useLogFilters() {
  const [query, setQuery] = useState('');
  const [levels, setLevels] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  return { query, setQuery, levels, setLevels, selected, setSelected };
}

export type LogFilterState = ReturnType<typeof useLogFilters>;

/**
 * Time window, facet filters and search over a log buffer, shared by the
 * project stream and the fleet stream. The buffer is windowed first, so the
 * facet counts describe what the chosen range actually contains.
 */
export function useLogStream<T extends LogLike>({
  entries,
  updatedAt,
  facets,
  search: searchOf,
  paused,
  onTogglePaused,
  range: controlledRange,
  onRangeChange,
  filters: controlledFilters,
}: {
  entries: T[];
  updatedAt: number;
  /** Held by the caller, because the polling query needs it too. */
  paused: boolean;
  onTogglePaused: () => void;
  /** Filterable dimensions beyond level, in the order they should be shown. */
  facets: LogFacet<T>[];
  /** Fields a free-text search should match, per entry. */
  search: (entry: T) => string[];
  /**
   * Held by the caller when the range also decides what is fetched: history
   * beyond the server's in-memory buffer has to be asked for by range, so the
   * query and the client-side window must not disagree about which one is on.
   */
  range?: LogRangeKey;
  onRangeChange?: (range: LogRangeKey) => void;
  /** Supply when the caller's fetch needs the filters too. See {@link useLogFilters}. */
  filters?: LogFilterState;
}) {
  const [uncontrolledRange, setUncontrolledRange] = useState<LogRangeKey>('1h');
  const range = controlledRange ?? uncontrolledRange;
  const setRange = (next: LogRangeKey) => {
    setUncontrolledRange(next);
    onRangeChange?.(next);
  };
  // Always created, then overridden: a hook cannot be called conditionally, and
  // the unused copy costs one useState triple.
  const internalFilters = useLogFilters();
  const { query, setQuery, levels, setLevels, selected, setSelected } = controlledFilters ?? internalFilters;

  const rangeMs = LOG_RANGE_MS[range];

  const windowed = useMemo(() => entriesSince(entries, updatedAt - rangeMs), [entries, updatedAt, rangeMs]);

  const options = useMemo(() => {
    const result: Record<string, FacetOption[]> = { level: levelOptions(windowed) };
    for (const facet of facets) result[facet.key] = facetOptions(windowed, facet.of, facet.values);
    return result;
    // facets is a literal rebuilt each render; its identity is not meaningful.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowed]);

  const filtered = useMemo(
    () => filterEntries(windowed, { levels, facets, selected, query, search: searchOf }),
    // facets and search are rebuilt each render; their identity is not meaningful.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [windowed, levels, selected, query],
  );

  const counts = useMemo(() => countByLevel(windowed), [windowed]);

  const hasFilters =
    levels.size > 0 || query.trim().length > 0 || facets.some(facet => (selected[facet.key]?.size ?? 0) > 0);

  return {
    range,
    rangeMs,
    setRange,
    query,
    setQuery,
    paused,
    togglePaused: onTogglePaused,
    levels,
    toggleLevel: (value: string) => setLevels(current => toggled(current, value)),
    clearLevels: () => setLevels(new Set()),
    selectedFor: (key: string) => selected[key] ?? new Set<string>(),
    toggleFacet: (key: string, value: string) =>
      setSelected(current => ({ ...current, [key]: toggled(current[key] ?? new Set(), value) })),
    clearFacet: (key: string) => setSelected(current => ({ ...current, [key]: new Set() })),
    optionsFor: (key: string) => options[key] ?? [],
    /** Replace every filter at once, which is what applying a saved view does. */
    applyFilters: (next: { levels: string[]; facets: Record<string, string[]>; query: string; range: LogRangeKey }) => {
      setLevels(new Set(next.levels));
      setSelected(Object.fromEntries(Object.entries(next.facets).map(([key, values]) => [key, new Set(values)])));
      setQuery(next.query);
      setRange(next.range);
    },
    clearAll: () => {
      setLevels(new Set());
      setSelected({});
      setQuery('');
    },
    hasFilters,
    windowed,
    filtered,
    counts,
    levelBuckets: bucketsByLevel(windowed, 60, rangeMs),
  };
}

function toggled(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
