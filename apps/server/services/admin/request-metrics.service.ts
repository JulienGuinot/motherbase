// In-memory, per-process request meter for the project API. Tracks a cumulative
// total plus a rolling 60s window used to derive requests-per-minute. Deliberately
// in-memory: cheap, lock-free, and resets on restart (acceptable for live gauges).
//
// A module-level singleton (`requestMeter`) is shared between the request-logger
// middleware (which records) and the admin controller (which reads), because the
// middleware runs outside the awilix request scope. `RequestMeter` is exported so
// it can be unit-tested in isolation.

const WINDOW_MS = 60_000;

export class RequestMeter {
  private total = 0;
  // Timestamps (ms) of requests within the rolling window, oldest first.
  private window: number[] = [];

  constructor(private windowMs = WINDOW_MS, private now: () => number = Date.now) {}

  /** Record one request. O(1) amortised. Prunes expired timestamps as it goes. */
  record(): void {
    const t = this.now();
    this.total += 1;
    this.window.push(t);
    this.prune(t);
  }

  /** Current snapshot: cumulative total, requests in the last window, window size. */
  snapshot(): { total: number; perMinute: number; windowSec: number } {
    const t = this.now();
    this.prune(t);
    return {
      total: this.total,
      perMinute: this.window.length,
      windowSec: Math.round(this.windowMs / 1000),
    };
  }

  reset(): void {
    this.total = 0;
    this.window = [];
  }

  private prune(t: number): void {
    const cutoff = t - this.windowMs;
    // Timestamps are monotonic non-decreasing, so drop from the front.
    let i = 0;
    while (i < this.window.length && this.window[i] < cutoff) i++;
    if (i > 0) this.window.splice(0, i);
  }
}

export const requestMeter = new RequestMeter();
