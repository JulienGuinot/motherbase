'use client';

import { formatDuration } from '@/shared/lib/format';
import type { MetricsCoverage } from '@/features/logs/types';

/**
 * Says what a chart actually covers when that is less than what was asked for.
 *
 * The range picker offers 24h and the metrics sampler is a ring buffer holding
 * roughly an hour, so selecting 24h drew one hour of samples under a 24h label
 * with nothing anywhere saying the other 23 were missing. A restart empties the
 * buffer too, so even 1h can be short.
 */
export function CoverageNotice({ coverage }: { coverage?: MetricsCoverage }) {
  if (!coverage || coverage.complete) return null;

  // Measured from the samples themselves, not from the clock: reading the clock
  // during render makes the output depend on when React happened to re-render.
  const covered =
    coverage.from && coverage.to ? Math.max(0, Date.parse(coverage.to) - Date.parse(coverage.from)) : 0;

  return (
    <div
      className="flex flex-wrap items-center gap-2 border px-3 py-2"
      style={{
        borderColor: 'color-mix(in srgb, var(--amber) 38%, transparent)',
        background: 'color-mix(in srgb, var(--amber) 8%, var(--surface))',
        borderRadius: 'var(--radius-md)',
      }}
      role="status"
    >
      <span className="text-[12px]">
        Showing {formatDuration(Math.round(covered / 1000))} of the{' '}
        {formatDuration(Math.round(coverage.requestedMs / 1000))} requested. These metrics are sampled in memory
        and keep about {formatDuration(Math.round(coverage.retainedMs / 1000))}, and the buffer is emptied by a
        restart.
      </span>
    </div>
  );
}
