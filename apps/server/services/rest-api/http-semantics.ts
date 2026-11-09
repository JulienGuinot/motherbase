// services/rest-api/http-semantics.ts
//
// The HTTP half of the PostgREST dialect: the `Prefer` request header, the
// `Range` request header, the `Content-Range` response header, and the response
// encodings selected through `Accept`.
//
// Kept out of `rest-api.service.ts` because none of it touches SQL, RLS or the
// realtime outbox. The service decides WHAT rows exist; this module decides how
// the caller asked for them and how they are rendered back.

import { HttpException } from '../../exceptions/http-exception';

/** `Prefer: count=` mode. `null` means the caller did not ask for a count. */
export type CountMode = 'exact' | 'planned' | 'estimated';

/** `Prefer: return=` mode. PostgREST's three values, verbatim. */
type ReturnMode = 'representation' | 'minimal' | 'headers-only';

/** `Prefer: resolution=` mode, which turns an insert into an upsert. */
type ResolutionMode = 'merge-duplicates' | 'ignore-duplicates';

export interface Preferences {
  count: CountMode | null;
  /** Writes default to minimal, like PostgREST. Rows require an explicit opt-in. */
  return: ReturnMode;
  resolution: ResolutionMode | null;
  /** `Prefer: params=single-object`, for `/rpc/`. */
  singleObjectParams: boolean;
  /**
   * `Prefer: max-affected=N`: refuse a write that would touch more rows than
   * this, and roll it back.
   *
   * The client has sent this since it gained `maxAffected()`. It was parsed
   * nowhere, so the guard against "an update whose filter had a typo hit the
   * whole table" was decorative: the caller asked to be protected, got a 200,
   * and the table was already rewritten.
   */
  maxAffected: number | null;
  /**
   * `Prefer: tx=rollback`: run the write, report what it would have done, and
   * roll the transaction back. A dry run.
   */
  txRollback: boolean;
}

const COUNT_MODES = new Set<string>(['exact', 'planned', 'estimated']);
const RETURN_MODES = new Set<string>(['representation', 'minimal', 'headers-only']);
const RESOLUTION_MODES = new Set<string>(['merge-duplicates', 'ignore-duplicates']);

function preferError(message: string): HttpException {
  return new HttpException(message, 400, 'PGRST122', { expose: true });
}

/**
 * Parse a `Prefer` header. Multiple preferences are comma separated and may
 * arrive as several header lines, which express hands over as an array.
 *
 * An unknown preference is ignored rather than rejected, because RFC 7240 makes
 * preferences advisory. An unknown VALUE for a preference we do implement is
 * rejected, since silently ignoring `count=aproximate` would return a response
 * that looks correct and is not.
 */
export function parsePrefer(header: string | string[] | undefined, defaultReturn: ReturnMode = 'minimal'): Preferences {
  const result: Preferences = {
    count: null,
    return: defaultReturn,
    resolution: null,
    singleObjectParams: false,
    maxAffected: null,
    txRollback: false,
  };
  if (!header) return result;

  const parts = (Array.isArray(header) ? header : [header])
    .flatMap(line => String(line).split(','))
    .map(part => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    const equals = part.indexOf('=');
    if (equals === -1) continue;
    const name = part.slice(0, equals).trim().toLowerCase();
    const value = part.slice(equals + 1).trim().toLowerCase().replace(/^"|"$/g, '');

    if (name === 'count') {
      if (!COUNT_MODES.has(value)) throw preferError(`Unsupported Prefer count=${value}`);
      result.count = value as CountMode;
    } else if (name === 'return') {
      if (!RETURN_MODES.has(value)) throw preferError(`Unsupported Prefer return=${value}`);
      result.return = value as ReturnMode;
    } else if (name === 'resolution') {
      if (!RESOLUTION_MODES.has(value)) throw preferError(`Unsupported Prefer resolution=${value}`);
      result.resolution = value as ResolutionMode;
    } else if (name === 'params') {
      if (value !== 'single-object') throw preferError(`Unsupported Prefer params=${value}`);
      result.singleObjectParams = true;
    } else if (name === 'max-affected') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw preferError(`Unsupported Prefer max-affected=${value}`);
      }
      result.maxAffected = parsed;
    } else if (name === 'tx') {
      // PostgREST also defines `tx=commit`, which is the default here.
      if (value !== 'rollback' && value !== 'commit') throw preferError(`Unsupported Prefer tx=${value}`);
      result.txRollback = value === 'rollback';
    }
  }

  return result;
}

export interface RangeRequest {
  offset: number;
  /** Absent for an open-ended range (`Range: 5-`). */
  limit?: number;
}

/**
 * Parse a `Range: 0-9` request header into offset/limit.
 *
 * PostgREST reads the range in ROWS, not bytes, and the bounds are inclusive, so
 * `0-9` is ten rows starting at zero. A `Range-Unit` other than `items` is not
 * ours to interpret and is ignored. `?limit`/`?offset` win when both are given,
 * matching PostgREST, so a client that sets both gets the explicit one.
 */
export function parseRange(header: string | string[] | undefined): RangeRequest | null {
  if (!header) return null;
  const raw = (Array.isArray(header) ? header[0] : header).trim();
  const match = /^(?:items=)?(\d+)-(\d*)$/.exec(raw);
  if (!match) return null;

  const from = Number(match[1]);
  if (!match[2]) return { offset: from };
  const to = Number(match[2]);
  if (to < from) throw new HttpException(`Invalid Range header: ${raw}`, 416, 'PGRST103', { expose: true });
  return { offset: from, limit: to - from + 1 };
}

/**
 * The `Content-Range` response value. `0-9/57` when the total is known, `0-9/*`
 * when it is not, and a star over zero for an empty result, exactly as
 * PostgREST spells it. (Spelling it literally here would close this comment.)
 */
export function contentRange(offset: number, rowCount: number, total: number | null): string {
  const totalPart = total === null ? '*' : String(total);
  if (rowCount === 0) return `*/${totalPart}`;
  return `${offset}-${offset + rowCount - 1}/${totalPart}`;
}

// ── Response encodings ───────────────────────────────────────────────────────

export const CSV_MEDIA_TYPE = 'text/csv';
/** PostgREST's "exactly one row" media type. */
const SINGLE_OBJECT_MEDIA_TYPE = 'application/vnd.pgrst.object+json';
const PLAN_MEDIA_TYPE = 'application/vnd.pgrst.plan';

export type ResponseEncoding = 'json' | 'csv' | 'single-object';

/** Pick the response encoding from `Accept`. Unknown types fall back to JSON. */
export function negotiate(accept: string | string[] | undefined): ResponseEncoding {
  const raw = (Array.isArray(accept) ? accept.join(',') : accept ?? '').toLowerCase();
  if (raw.includes(SINGLE_OBJECT_MEDIA_TYPE)) return 'single-object';
  if (raw.includes(CSV_MEDIA_TYPE)) return 'csv';
  return 'json';
}

export function wantsPlan(accept: string | string[] | undefined): boolean {
  const raw = (Array.isArray(accept) ? accept.join(',') : accept ?? '').toLowerCase();
  return raw.includes(PLAN_MEDIA_TYPE);
}

/**
 * `application/vnd.pgrst.object+json` semantics: exactly one row, or a 406.
 *
 * PostgREST answers 406 (not 404) for both "no rows" and "more than one row",
 * because the failure is that the requested REPRESENTATION cannot be produced,
 * not that the resource is missing.
 */
export function toSingleObject(rows: unknown[]): unknown {
  if (rows.length === 1) return rows[0];
  throw new HttpException(
    'JSON object requested, multiple (or no) rows returned',
    406,
    'PGRST116',
    { expose: true },
  );
}

/**
 * Render rows as CSV. The header row is the union of the keys, in first-seen
 * order, so a projection with a NULL-only column still names it.
 *
 * Quoting follows RFC 4180: a field is quoted when it contains a comma, a quote,
 * a CR or an LF, and an embedded quote is doubled. Objects and arrays are
 * rendered as their JSON text, which is what PostgREST does for json columns.
 */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row ?? {})) if (!columns.includes(key)) columns.push(key);
  }
  if (!columns.length) return '';

  const lines = [columns.map(csvField).join(',')];
  for (const row of rows) lines.push(columns.map(column => csvField(row?.[column])).join(','));
  return lines.join('\n');
}

function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text =
    typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
