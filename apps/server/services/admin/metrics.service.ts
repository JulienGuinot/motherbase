import { shieldTelemetry } from '../../lib/shield-telemetry';

export interface MetricSample {
  at: string;      // ISO timestamp, end of this sample's bucket
  rps: number;     // requests/sec over the trailing smoothing window
  p95: number;     // p95 latency (ms) over the trailing smoothing window
  errorRate: number; // fraction of 4xx/5xx responses in THIS bucket [0..1]
  memMb: number;   // resident set size (MB)
  /**
   * Requests counted in this sample's own bucket, disjoint from its neighbours.
   *
   * This used to be the count over a 60s trailing window taken every 10s, so
   * the same request appeared in six consecutive samples and any consumer that
   * summed the series (the console's Requests total does) reported about six
   * times the real traffic. Buckets are disjoint now, so summing is correct.
   */
  reqs: number;
  /** Errors in this sample's own bucket, on the same disjoint basis as `reqs`. */
  errs: number;
  /** Milliseconds this bucket covers, so a partial first bucket is visible. */
  bucketMs: number;
}

/** Coverage of a returned series, so a range picker cannot imply data it has not got. */
export interface MetricsCoverage {
  /** Oldest sample timestamp held, or null when the buffer is empty. */
  from: string | null;
  to: string | null;
  /** How far back this process can ever answer, whatever range is asked for. */
  retainedMs: number;
  /** The range that was requested. */
  requestedMs: number;
  /** False when `requestedMs` reaches further back than the buffer can cover. */
  complete: boolean;
}

const SAMPLE_INTERVAL_MS = 10_000;   // sample cadence, and the bucket width
const SMOOTHING_WINDOW_MS = 60_000;  // trailing window for rate/latency only
const MAX_SAMPLES = 360;             // ~1h of history at 10s cadence

/** The longest range this buffer can actually answer. */
export const METRICS_RETENTION_MS = MAX_SAMPLES * SAMPLE_INTERVAL_MS;

/**
 * In-memory time-series of runtime metrics. A single timer samples the shield
 * telemetry + process memory on a fixed cadence into a ring buffer. Mirrors the
 * ephemeral logs buffer: history is lost on restart (by design. No persistence).
 */
class MetricsService {
  private samples: MetricSample[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** End of the previous bucket, so consecutive buckets neither overlap nor gap. */
  private lastSampleAt = Date.now();

  /** Start the sampler (idempotent: guards against duplicate timers). */
  start(): void {
    if (this.timer) return;
    this.lastSampleAt = Date.now() - SAMPLE_INTERVAL_MS;
    this.sample(); // seed one immediately
    this.timer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    // Don't keep the event loop alive for the sampler alone.
    this.timer.unref?.();
  }

  private sample(): void {
    try {
      const now = Date.now();
      const from = this.lastSampleAt;
      const runtime = shieldTelemetry.runtimeSummary(SMOOTHING_WINDOW_MS);
      // Counted over (from, now], not over a trailing window: see MetricSample.reqs.
      const bucket = shieldTelemetry.countsBetween(from, now);
      const rss = process.memoryUsage().rss;
      this.samples.push({
        at: new Date(now).toISOString(),
        rps: runtime.throughputRps ?? 0,
        p95: runtime.p95Ms ?? 0,
        errorRate: bucket.requests > 0 ? bucket.errors / bucket.requests : 0,
        memMb: Math.round((rss / (1024 * 1024)) * 10) / 10,
        reqs: bucket.requests,
        errs: bucket.errors,
        bucketMs: Math.max(1, now - from),
      });
      this.lastSampleAt = now;
      if (this.samples.length > MAX_SAMPLES) {
        this.samples.splice(0, this.samples.length - MAX_SAMPLES);
      }
    } catch {
      // Sampling must never throw into the timer; skip this tick on error.
    }
  }

  /** Return samples within the trailing `rangeMs` window (default full buffer). */
  getTimeseries(rangeMs?: number): MetricSample[] {
    if (!rangeMs) return [...this.samples];
    const since = Date.now() - rangeMs;
    return this.samples.filter(s => Date.parse(s.at) >= since);
  }

  /**
   * Samples plus what they actually cover.
   *
   * The range picker offers 24h while this buffer holds about an hour, and the
   * console drew the hour it got under a "24h" label with nothing saying the
   * other 23 were missing. `coverage` is what lets it say so.
   */
  getSeries(rangeMs?: number): { samples: MetricSample[]; coverage: MetricsCoverage } {
    const samples = this.getTimeseries(rangeMs);
    const requestedMs = rangeMs ?? METRICS_RETENTION_MS;
    const oldest = this.samples[0]?.at ?? null;
    const covered = oldest ? Date.now() - Date.parse(oldest) : 0;
    return {
      samples,
      coverage: {
        from: samples[0]?.at ?? null,
        to: samples[samples.length - 1]?.at ?? null,
        retainedMs: METRICS_RETENTION_MS,
        requestedMs,
        // A margin of one bucket: a buffer that has just filled should not be
        // reported as incomplete because it is 10s short.
        complete: covered + SAMPLE_INTERVAL_MS >= requestedMs,
      },
    };
  }
}

export const metricsService = new MetricsService();
metricsService.start();
