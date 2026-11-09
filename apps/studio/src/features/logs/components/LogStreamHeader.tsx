'use client';

import type { ReactNode } from 'react';
import { LogHistogram } from '@/features/logs/components/LogHistogram';
import { LevelStat } from '@/features/logs/components/LevelStat';
import type { LogLevel } from '@/features/logs/lib/log-stream';

/** Recording state, the counts in the current window, and the volume histogram. */
export function LogStreamHeader({
  paused,
  shown,
  total,
  range,
  description,
  counts,
  levelBuckets,
  children,
}: {
  paused: boolean;
  shown: number;
  total: number;
  range: string;
  description: ReactNode;
  counts: { info: number; warn: number; error: number };
  levelBuckets: Record<LogLevel, number[]>;
  /** Notices that belong with the header, such as unreachable projects. */
  children?: ReactNode;
}) {
  const errorShare = total === 0 ? 0 : counts.error / total;

  return (
    <header className="card relative overflow-hidden p-6">
      <div className="grid gap-6 md:grid-cols-[1fr_auto]">
        <div>
          <div className="flex items-center gap-2">
            {paused ? (
              <span className="chip" style={{ color: 'var(--amber)' }}>
                Paused
              </span>
            ) : (
              <span className="chip">
                <span className="dot dot-live" /> Recording
              </span>
            )}
            {counts.error > 0 && (
              <span className="chip tabular-nums" style={{ color: 'var(--red)' }}>
                {(errorShare * 100).toFixed(1)}% errors
              </span>
            )}
          </div>

          <h1
            className="mt-2 text-[18px] tabular-nums justify-end"
            style={{ color: 'var(--text)', fontWeight: 600, letterSpacing: '-0.01em' }}
          >
            {shown} <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}>events</span>
          </h1>

          <p className="mt-1 text-[13px]" style={{ color: 'var(--text-dim)' }}>
            Showing {shown} of {total} in last {range}. {description}
          </p>
        </div>

        <div className="flex items-end gap-4">
          <LevelStat label="Info" value={counts.info} color="var(--text)" />
          <LevelStat label="Warn" value={counts.warn} color="var(--amber)" />
          <LevelStat label="Error" value={counts.error} color="var(--red)" />
        </div>
      </div>

      {children}

      <div className="mt-4">
        <LogHistogram levelBuckets={levelBuckets} range={range} />
      </div>
    </header>
  );
}
