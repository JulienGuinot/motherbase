import { describe, expect, it } from 'vitest';
import { maxCronGapMs } from '../lib/cron-cadence';

// A fixed reference so day-of-week and month-length cases are deterministic.
// 2026-03-02 is a Monday.
const FROM = new Date('2026-03-02T00:00:00.000Z');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('maxCronGapMs', () => {
  it('measures a simple interval schedule', () => {
    expect(maxCronGapMs('*/5 * * * *', FROM)).toBe(5 * MINUTE);
    expect(maxCronGapMs('* * * * *', FROM)).toBe(MINUTE);
  });

  it('measures a daily schedule', () => {
    expect(maxCronGapMs('0 3 * * *', FROM)).toBe(DAY);
  });

  it('reports the LONGEST gap, not the shortest', () => {
    // Fires at 09:00 and 17:00: eight hours apart one way, sixteen the other.
    // Taking the short gap as the tolerance would page every single night.
    expect(maxCronGapMs('0 9,17 * * *', FROM)).toBe(16 * HOUR);
  });

  it('measures a weekly schedule', () => {
    expect(maxCronGapMs('0 4 * * 1', FROM)).toBe(7 * DAY);
    // 7 and 0 are both Sunday.
    expect(maxCronGapMs('0 4 * * 7', FROM)).toBe(7 * DAY);
  });

  it('treats a restricted day-of-month and day-of-week as a union, as cron does', () => {
    // Cron fires on the 1st OR on any Monday, never the intersection. Reading it
    // as an intersection would understate every gap for this expression.
    const union = maxCronGapMs('0 0 1 * 1', FROM);
    const mondaysOnly = maxCronGapMs('0 0 * * 1', FROM);
    expect(union).not.toBeNull();
    expect(union!).toBeLessThanOrEqual(mondaysOnly!);
  });

  it('accepts month and weekday names', () => {
    expect(maxCronGapMs('0 4 * * MON', FROM)).toBe(7 * DAY);
  });

  it('ignores the seconds field of a 6-field expression', () => {
    // Extra firings inside a minute only shorten gaps, so the minute-level
    // answer stays a safe upper bound for an alert window.
    expect(maxCronGapMs('30 */5 * * * *', FROM)).toBe(5 * MINUTE);
  });

  it('returns null rather than guessing at an unsupported expression', () => {
    expect(maxCronGapMs('not a cron', FROM)).toBeNull();
    expect(maxCronGapMs('* * *', FROM)).toBeNull();
    expect(maxCronGapMs('*/0 * * * *', FROM)).toBeNull();
    expect(maxCronGapMs('99 * * * *', FROM)).toBeNull();
  });

  it('returns null for a schedule too sparse to observe twice', () => {
    // Once a year: the scan window cannot see two firings, so there is no
    // measured gap to report and inventing one would be worse.
    expect(maxCronGapMs('0 0 1 1 *', FROM)).toBeNull();
  });
});
