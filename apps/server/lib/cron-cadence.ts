/**
 * How far apart two firings of a cron expression can be.
 *
 * node-cron answers "when does this fire next" and nothing else, so a schedule
 * cannot state its own tolerance without walking it. The missed-window alert
 * rule needs that tolerance: without it the only options are a hardcoded window
 * (which is how a 26-hour RPO ended up firing on a backup that was minutes old)
 * or no missed-window rule at all, which is what the console shipped.
 *
 * Deliberately a scan and not a parser-and-solver: the expressions here are
 * operator-written 5-field schedules, and a scan is the version that stays
 * obviously correct when someone reads it at 3am.
 */

const NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/**
 * How far to walk. A schedule sparser than this reports null rather than a
 * guess, and 40 days always spans at least one month boundary so a
 * day-of-month schedule sees a short month as well as a long one.
 */
const WINDOW_DAYS = 40;
const MINUTE_MS = 60_000;

// Keyed by expression only: the answer barely moves with the starting instant,
// and this is read on every alert evaluation.
// ponytail: unbounded map, bound it if operators ever author expressions in a loop.
const cache = new Map<string, number | null>();

function parseField(field: string, min: number, max: number): Set<number> | null {
  const allowed = new Set<number>();
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;

    let from: number;
    let to: number;
    if (range === '*') {
      from = min;
      to = max;
    } else {
      const [lowText, highText] = range.split('-');
      const low = value(lowText);
      const high = highText === undefined ? (stepText === undefined ? low : max) : value(highText);
      if (low === null || high === null || low > high) return null;
      from = low;
      to = high;
    }
    if (from < min || to > max) return null;
    for (let n = from; n <= to; n += step) allowed.add(n);
  }
  return allowed.size ? allowed : null;

  function value(text: string): number | null {
    const named = NAMES[text?.toLowerCase()];
    if (named !== undefined) return named;
    const n = Number(text);
    return Number.isInteger(n) ? n : null;
  }
}

/**
 * Longest gap between two firings, in milliseconds, or null when the expression
 * is unsupported or fires less than twice in {@link WINDOW_DAYS}.
 *
 * A 6-field expression's seconds are ignored: every extra firing inside a minute
 * only shortens gaps, so the minute-level answer stays an upper bound and the
 * rule built on it stays conservative.
 */
export function maxCronGapMs(expression: string, from = new Date()): number | null {
  const key = expression.trim();
  if (cache.has(key)) return cache.get(key)!;
  const result = compute(key, from);
  cache.set(key, result);
  return result;
}

function compute(expression: string, from: Date): number | null {
  const parts = expression.trim().split(/\s+/);
  const fields = parts.length === 6 ? parts.slice(1) : parts;
  if (fields.length !== 5) return null;

  const minutes = parseField(fields[0], 0, 59);
  const hours = parseField(fields[1], 0, 23);
  const days = parseField(fields[2], 1, 31);
  const months = parseField(fields[3], 1, 12);
  const weekdays = parseField(fields[4], 0, 7);
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  // Cron's 7 and 0 are both Sunday.
  if (weekdays.has(7)) weekdays.add(0);

  // A restricted day-of-month AND a restricted day-of-week are a union in cron,
  // not an intersection. Getting this backwards would understate every gap.
  const dayRestricted = fields[2] !== '*';
  const weekdayRestricted = fields[4] !== '*';

  const start = new Date(from.getTime());
  start.setSeconds(0, 0);

  let previous: number | null = null;
  let widest = 0;
  let fires = 0;
  const cursor = new Date(start.getTime());
  const end = start.getTime() + WINDOW_DAYS * 24 * 60 * MINUTE_MS;

  for (let at = start.getTime(); at <= end; at += MINUTE_MS) {
    cursor.setTime(at);
    if (!minutes.has(cursor.getMinutes())) continue;
    if (!hours.has(cursor.getHours())) continue;
    if (!months.has(cursor.getMonth() + 1)) continue;

    const dayOk = days.has(cursor.getDate());
    const weekdayOk = weekdays.has(cursor.getDay());
    const matchesDay =
      dayRestricted && weekdayRestricted ? dayOk || weekdayOk : dayRestricted ? dayOk : weekdayRestricted ? weekdayOk : true;
    if (!matchesDay) continue;

    fires++;
    if (previous !== null) widest = Math.max(widest, at - previous);
    previous = at;
  }

  return fires >= 2 ? widest : null;
}
