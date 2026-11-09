import type { Prisma } from '@prisma/client';
import type { LogEntry } from './log-buffer';
import type { LogService } from './log-services';

/** An inclusive HTTP status range; `404` is `{ min: 404, max: 404 }`. */
export interface StatusRange {
  min: number;
  max: number;
}

/**
 * Every filter the Logs Explorer offers. One definition, applied two ways:
 * `matchesLogFilter` for the in-memory buffer and `logFilterWhere` for the
 * table, so both sources answer the same question the same way.
 */
export interface LogFilter {
  since?: Date;
  until?: Date;
  levels?: string[];
  sources?: string[];
  services?: LogService[];
  /** Lowercased. Matched against the message and the request fields. */
  search?: string;
  statuses?: StatusRange[];
  method?: string;
  /** Substring of the request path, case-insensitive. */
  path?: string;
  userId?: string;
  /** Keyset cursor: only lines strictly older than this one. See {@link logCursor}. */
  before?: LogCursor;
}

/**
 * A position in the newest-first order, `(at, id)`. Neither half is enough on
 * its own: a burst writes many lines in the same millisecond, so paging by `at`
 * alone would repeat or skip them at a page boundary, and ids are not ordered
 * by `at` across a restart of the buffer.
 */
export interface LogCursor {
  at: Date;
  id: number;
}

/** `<epoch ms>:<id>`, what the client hands back to ask for the page after `entry`. */
export function logCursor(entry: Pick<LogEntry, 'at' | 'id'>): string {
  return `${Date.parse(entry.at)}:${entry.id}`;
}

/** Null for anything that is not a cursor this server produced. */
export function parseLogCursor(raw: string): LogCursor | null {
  const match = /^(\d+):(\d+)$/.exec(raw);
  return match ? { at: new Date(Number(match[1])), id: Number(match[2]) } : null;
}

const STATUS_TOKEN = /^([1-5])xx$|^(\d{3})(?:-(\d{3}))?$/i;

/**
 * `5xx`, `404`, `400-499`, or several of them comma-separated. Returns null
 * for anything else, so a typo is refused instead of silently matching all.
 */
export function parseStatusFilter(raw: string): StatusRange[] | null {
  const ranges: StatusRange[] = [];
  for (const token of raw.split(',').map(part => part.trim()).filter(Boolean)) {
    const match = STATUS_TOKEN.exec(token);
    if (!match) return null;
    if (match[1]) ranges.push({ min: Number(match[1]) * 100, max: Number(match[1]) * 100 + 99 });
    else ranges.push({ min: Number(match[2]), max: Number(match[3] ?? match[2]) });
  }
  return ranges.length ? ranges : null;
}

const SEARCHED_FIELDS = ['message', 'path', 'ip', 'userAgent', 'requestId', 'userId'] as const;

/** `api` is the gateway view: every request line, whatever service it reached. */
function matchesService(entry: Pick<LogEntry, 'service' | 'method'>, services: LogService[]): boolean {
  return services.some(service => (service === 'api' ? entry.method != null : entry.service === service));
}

export function matchesLogFilter(entry: LogEntry, filter: LogFilter): boolean {
  const at = Date.parse(entry.at);
  if (filter.since && at < filter.since.getTime()) return false;
  if (filter.until && at > filter.until.getTime()) return false;
  if (filter.levels?.length && !filter.levels.includes(entry.level)) return false;
  if (filter.sources?.length && !filter.sources.includes(entry.source)) return false;
  if (filter.services?.length && !matchesService(entry, filter.services)) return false;
  if (filter.statuses?.length) {
    const status = entry.status;
    if (status == null || !filter.statuses.some(range => status >= range.min && status <= range.max)) return false;
  }
  if (filter.method && entry.method?.toUpperCase() !== filter.method.toUpperCase()) return false;
  if (filter.path && !entry.path?.toLowerCase().includes(filter.path.toLowerCase())) return false;
  if (filter.userId && entry.userId !== filter.userId) return false;
  if (filter.before) {
    const { at: cursorAt, id } = filter.before;
    if (at > cursorAt.getTime() || (at === cursorAt.getTime() && entry.id >= id)) return false;
  }
  if (filter.search) {
    const needle = filter.search;
    if (!SEARCHED_FIELDS.some(field => String(entry[field] ?? '').toLowerCase().includes(needle))) return false;
  }
  return true;
}

export function logFilterWhere(filter: LogFilter): Prisma.RequestLogWhereInput {
  const and: Prisma.RequestLogWhereInput[] = [];
  if (filter.since || filter.until) {
    and.push({ at: { ...(filter.since ? { gte: filter.since } : {}), ...(filter.until ? { lte: filter.until } : {}) } });
  }
  if (filter.levels?.length) and.push({ level: { in: filter.levels } });
  if (filter.sources?.length) and.push({ source: { in: filter.sources } });
  if (filter.services?.length) {
    and.push({
      OR: filter.services.map(service => (service === 'api' ? { method: { not: null } } : { service })),
    });
  }
  if (filter.statuses?.length) {
    and.push({ OR: filter.statuses.map(range => ({ status: { gte: range.min, lte: range.max } })) });
  }
  if (filter.method) and.push({ method: { equals: filter.method, mode: 'insensitive' } });
  if (filter.path) and.push({ path: { contains: filter.path, mode: 'insensitive' } });
  if (filter.userId) and.push({ userId: filter.userId });
  if (filter.before) {
    // Served by the (at, id) index, which is also what the page is ordered by.
    const { at, id } = filter.before;
    and.push({ OR: [{ at: { lt: at } }, { at, id: { lt: id } }] });
  }
  if (filter.search) {
    const contains = filter.search;
    and.push({ OR: SEARCHED_FIELDS.map(field => ({ [field]: { contains, mode: 'insensitive' } })) });
  }
  return and.length ? { AND: and } : {};
}
