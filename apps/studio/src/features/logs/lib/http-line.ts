/**
 * The HTTP lines in the buffer are formatted by `middlewares/request-logger.ts`
 * as `METHOD /path → STATUS (12ms) [request-id]`. Reading that back apart lets
 * the Logs screen show them as aligned columns with a coloured status, instead
 * of one grey sentence per row that the eye has to re-parse every time.
 *
 * Anything that does not match falls through to the plain message renderer, so
 * a change to the producer's format degrades to today's behaviour rather than
 * to a wrong row.
 */
export interface HttpLine {
  method: string;
  path: string;
  status: number;
  ms: number;
  redirect?: string;
  requestId?: string;
}

// A 3xx line carries its Location target as ` ⇢ <url>` between the duration and
// the request id (see `middlewares/request-logger.ts`). It is optional, so it
// sits between the two other optional tails and must not swallow the `[id]`.
const HTTP_LINE = /^([A-Z]+)\s+(\S+)\s+→\s+(\d{3})\s+\((\d+)ms\)(?:\s+⇢\s+(\S+))?(?:\s+\[([^\]]+)\])?\s*$/;

export function parseHttpLine(message: string): HttpLine | null {
  const match = HTTP_LINE.exec(message);
  if (!match) return null;
  return {
    method: match[1],
    path: match[2],
    status: Number(match[3]),
    ms: Number(match[4]),
    redirect: match[5],
    requestId: match[6],
  };
}

/** Status colour by class, the same scale Vercel and Supabase use. */
export function statusColor(status: number): string {
  if (status >= 500) return 'var(--red)';
  if (status >= 400) return 'var(--amber)';
  if (status >= 300) return 'var(--blue)';
  return 'var(--green)';
}

/** Slow requests should read as slow before the number is read. */
export function durationColor(ms: number): string {
  if (ms >= 1000) return 'var(--red)';
  if (ms >= 300) return 'var(--amber)';
  return 'var(--text-mute)';
}

const METHOD_COLOR: Record<string, string> = {
  GET: 'var(--blue)',
  POST: 'var(--green)',
  PUT: 'var(--purple)',
  PATCH: 'var(--purple)',
  DELETE: 'var(--red)',
};

export function methodColor(method: string): string {
  return METHOD_COLOR[method] ?? 'var(--text-dim)';
}
