import type { LogLevel } from '@/features/logs/lib/log-stream';

const BAR_COLOR: Record<LogLevel, string> = {
  info: 'var(--accent)',
  warn: 'var(--amber)',
  error: 'var(--red)',
};

/**
 * Stacked volume-over-time bars for the log header, replacing the smoothed
 * sparkline that was there.
 *
 * A sparkline interpolates between samples, which is exactly wrong for counts:
 * it draws a slope between two buckets that never happened, and at the low
 * counts a log window usually holds it reads as a flat line whatever the data
 * did. Bars are discrete, and stacking them by level answers "was that spike
 * traffic, or errors" without a second chart.
 *
 * Pure CSS, no chart library: it is 60 divs.
 */
export function LogHistogram({
  levelBuckets,
  height = 56,
  range,
}: {
  levelBuckets: Record<LogLevel, number[]>;
  height?: number;
  /** Right-hand caption, e.g. "15m", so the axis is not a mystery. */
  range?: string;
}) {
  const slots = levelBuckets.error.length;
  const totals = Array.from({ length: slots }, (_, index) =>
    levelBuckets.info[index]! + levelBuckets.warn[index]! + levelBuckets.error[index]!,
  );
  const peak = Math.max(1, ...totals);

  return (
    <div>
      <div className="flex items-end gap-[2px]" style={{ height }}>
        {totals.map((total, index) => {
          const scale = total / peak;
          return (
            <div
              key={index}
              className="flex min-w-0 flex-1 flex-col justify-end"
              style={{ height: '100%' }}
              title={`${total} event${total === 1 ? '' : 's'}`}
            >
              {(['error', 'warn', 'info'] as LogLevel[]).map(level => {
                const count = levelBuckets[level][index]!;
                if (count === 0) return null;
                return (
                  <div
                    key={level}
                    style={{
                      // Share of this bar's height, times the bar's share of the peak.
                      height: `${(count / total) * scale * 100}%`,
                      background: BAR_COLOR[level],
                      opacity: level === 'info' ? 0.45 : 0.9,
                      minHeight: 1,
                    }}
                  />
                );
              })}
              {/* Baseline tick, so an empty slot still reads as a slot. */}
              {total === 0 && <div style={{ height: 1, background: 'var(--border)' }} />}
            </div>
          );
        })}
      </div>

      {range && (
        <div className="mt-1.5 flex justify-between text-[10px]" style={{ color: 'var(--text-mute)' }}>
          <span>{range} ago</span>
          <span>now</span>
        </div>
      )}
    </div>
  );
}
