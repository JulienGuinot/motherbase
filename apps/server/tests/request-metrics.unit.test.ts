import { describe, it, expect } from 'vitest';
import { RequestMeter } from '../services/admin/request-metrics.service';

describe('RequestMeter', () => {
  it('increments the cumulative total on each record', () => {
    const m = new RequestMeter();
    m.record();
    m.record();
    m.record();
    expect(m.snapshot().total).toBe(3);
  });

  it('computes req/min over the rolling window and drops expired timestamps', () => {
    let now = 1_000_000;
    const m = new RequestMeter(60_000, () => now);

    m.record(); // t=1_000_000
    now += 10_000;
    m.record(); // +10s
    now += 10_000;
    m.record(); // +20s

    // All three within the 60s window (records at t, t+10s, t+20s).
    expect(m.snapshot().perMinute).toBe(3);

    // Advance to 65s after the first record: only the first has expired.
    now += 45_000; // records now aged 65s / 55s / 45s
    expect(m.snapshot().perMinute).toBe(2);

    // Advance another 10s so the second also expires; only the third remains.
    now += 10_000; // records aged 75s / 65s / 55s
    const snap = m.snapshot();
    expect(snap.perMinute).toBe(1);
    expect(snap.total).toBe(3); // total never decays
    expect(snap.windowSec).toBe(60);
  });

  it('reports boot as the last activity until a caller request touches it', () => {
    let now = 1_000;
    const m = new RequestMeter(60_000, () => now);
    now = 5_000;
    m.record(); // metered traffic (Studio, the Console's own polling) is not activity
    expect(m.snapshot().lastActivityAt).toBe(1_000);
    m.touch();
    expect(m.snapshot().lastActivityAt).toBe(5_000);
  });

  it('reset clears total and window', () => {
    const m = new RequestMeter();
    m.record();
    m.reset();
    expect(m.snapshot()).toMatchObject({ total: 0, perMinute: 0 });
  });
});
