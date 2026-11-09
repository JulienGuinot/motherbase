export type RangeKey = '15m' | '1h' | '24h';

export const RANGE_MS: Record<RangeKey, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
};

export type LogRangeKey = '15m' | '1h' | '6h' | '24h' | '7d' | '30d';

/**
 * Ranges for the log streams. Wider than RANGE_MS, which stays as it is
 * because the metrics it serves come from an in-memory ring of ~1h of samples:
 * offering 30d there would only ever draw the same hour. Logs are read back
 * out of `platform.request_logs`, so these are real windows, bounded by the
 * retention configured under Settings > Logs.
 */
export const LOG_RANGE_MS: Record<LogRangeKey, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
};

/**
 * What the fleet stream can honestly offer. It merges in-memory buffers from
 * every running project and the console's own, with no table behind them, so a
 * 30d selection there would only ever redraw the same few hundred lines.
 */
export const FLEET_RANGE_MS: Partial<Record<LogRangeKey, number>> = {
  '15m': LOG_RANGE_MS['15m'],
  '1h': LOG_RANGE_MS['1h'],
  '6h': LOG_RANGE_MS['6h'],
  '24h': LOG_RANGE_MS['24h'],
};
