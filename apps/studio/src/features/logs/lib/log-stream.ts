import { bucketCounts } from '@/shared/lib/buckets';

export type LogLevel = 'info' | 'warn' | 'error';

/** The shape both log streams share: the project buffer and the fleet buffer. */
export interface LogLike {
  at: string;
  level: LogLevel;
  source: string;
  message: string;
  // Structured detail from the server's request logger. Optional: only inbound
  // HTTP lines carry it, and an older server sends none of it at all.
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  userId?: string;
}

export const LEVELS: LogLevel[] = ['info', 'warn', 'error'];

export const LEVEL_COLOR: Record<LogLevel, string> = {
  info: 'var(--text)',
  warn: 'var(--amber)',
  error: 'var(--red)',
};

export const LEVEL_STYLE: Record<LogLevel, { color: string; dot: string }> = {
  info: { color: 'var(--text-mute)', dot: 'dot-info' },
  warn: { color: 'var(--amber)', dot: 'dot-warn' },
  error: { color: 'var(--red)', dot: 'dot-err' },
};

/** One filterable dimension of a log entry, e.g. its source or its project. */
export interface LogFacet<T> {
  key: string;
  label: string;
  of: (entry: T) => string;
  /**
   * Canonical values, always shown in this order regardless of what the current
   * window contains. Without it the option list is derived from the visible
   * lines and reshuffles on every 2s refresh as sources appear, vanish and swap
   * rank by count. Leave undefined for a genuinely open dimension (e.g. which
   * projects exist in a fleet), where a fixed domain cannot be known ahead.
   */
  values?: string[];
}

/**
 * Every source the backend can emit, in a fixed display order. `http` and `sql`
 * come from the request logger and the SQL editor; the rest are the
 * `ActivitySource` union in `apps/server/lib/activity-log.ts`. Kept here so the
 * Logs source facet stays put instead of following the traffic.
 */
export const LOG_SOURCES = ['http', 'sql', 'auth', 'edge', 'storage', 'realtime', 'job', 'webhook', 'ai', 'shield'];

export interface FacetOption {
  value: string;
  count: number;
  color?: string;
}

/**
 * Facet values with their counts. With a `domain` the list is that domain, in
 * its given order, with current counts (zero allowed) — a stable set that does
 * not reshuffle as lines stream in; any value seen but not in the domain is
 * appended, most frequent first, so an unexpected source is never hidden.
 * Without a `domain` the options are just what was observed, most frequent first.
 */
export function facetOptions<T>(entries: T[], of: (entry: T) => string, domain?: string[]): FacetOption[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const value = of(entry);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  if (domain) {
    const known = new Set(domain);
    const fixed = domain.map(value => ({ value, count: counts.get(value) ?? 0 }));
    const extra = Array.from(counts.entries())
      .filter(([value]) => !known.has(value))
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, count }));
    return [...fixed, ...extra];
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, count }));
}

/** Level counts, always in info/warn/error order even when one is absent. */
export function levelOptions<T extends LogLike>(entries: T[]): FacetOption[] {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.level, (counts.get(entry.level) ?? 0) + 1);
  return LEVELS.map(level => ({ value: level, count: counts.get(level) ?? 0, color: LEVEL_COLOR[level] }));
}

/** A timestamp with milliseconds, which is what separates two close log lines. */
export function logTime(at: string): string {
  const date = new Date(at);
  return `${date.toLocaleTimeString()}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}


/**
 * Per-level counts per time slot, for the stacked histogram in the stream
 * header. A single total line hides the thing worth seeing: whether the spike
 * at 14:02 was traffic or a burst of errors.
 */
export function bucketsByLevel<T extends LogLike>(
  items: T[],
  slots: number,
  windowMs: number,
): Record<LogLevel, number[]> {
  return {
    info: bucketCounts(items.filter(item => item.level === 'info'), slots, windowMs),
    warn: bucketCounts(items.filter(item => item.level === 'warn'), slots, windowMs),
    error: bucketCounts(items.filter(item => item.level === 'error'), slots, windowMs),
  };
}

/** Entries at or after `since`. An unparseable timestamp is kept rather than hidden. */
export function entriesSince<T extends LogLike>(entries: T[], since: number): T[] {
  return entries.filter(entry => {
    const at = Date.parse(entry.at);
    return Number.isNaN(at) || at >= since;
  });
}

export interface LogFilterCriteria<T> {
  levels: Set<string>;
  facets: LogFacet<T>[];
  selected: Record<string, Set<string>>;
  query: string;
  search: (entry: T) => string[];
}

/** Entries matching every active filter, newest first. */
export function filterEntries<T extends LogLike>(
  entries: T[],
  { levels, facets, selected, query, search }: LogFilterCriteria<T>,
): T[] {
  const term = query.trim().toLowerCase();
  const activeFacets = facets.filter(facet => selected[facet.key]?.size);
  return entries
    .filter(entry =>
      (!levels.size || levels.has(entry.level))
      && activeFacets.every(facet => selected[facet.key].has(facet.of(entry)))
      && (!term || search(entry).some(value => value.toLowerCase().includes(term))))
    .reverse();
}

export function countByLevel<T extends LogLike>(entries: T[]): Record<LogLevel, number> {
  const counts: Record<LogLevel, number> = { info: 0, warn: 0, error: 0 };
  for (const entry of entries) counts[entry.level] += 1;
  return counts;
}
