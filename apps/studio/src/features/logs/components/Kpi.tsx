import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import type { Trend } from '@/features/logs/lib/insights';

/**
 * Whether a rise is good news depends on the metric: more requests per second
 * is healthy, more p95 is not. The caller says which, since the number itself
 * cannot know.
 */
export type TrendPolarity = 'higher-is-better' | 'lower-is-better' | 'neutral';

function trendColor(direction: Trend['direction'], polarity: TrendPolarity): string {
  if (direction === 'flat' || polarity === 'neutral') return 'var(--text-mute)';
  const good = polarity === 'higher-is-better' ? direction === 'up' : direction === 'down';
  return good ? 'var(--green)' : 'var(--red)';
}

function TrendChip({ trend, polarity }: { trend: Trend; polarity: TrendPolarity }) {
  const color = trendColor(trend.direction, polarity);
  const Icon = trend.direction === 'up' ? ArrowUpRight : trend.direction === 'down' ? ArrowDownRight : Minus;
  const label =
    trend.changeRatio == null || trend.direction === 'flat'
      ? 'steady'
      : `${Math.abs(trend.changeRatio * 100).toFixed(0)}%`;

  return (
    <span
      className="tabular-nums inline-flex shrink-0 items-center gap-0.5 text-[11px]"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)`, borderRadius: 5, padding: '1px 5px' }}
      title="Compared with the start of the selected window"
    >
      <Icon size={11} />
      {label}
    </span>
  );
}

export function Kpi({
  icon,
  label,
  value,
  sub,
  color,
  trend,
  polarity = 'neutral',
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub: string;
  color: string;
  /** Movement across the window, rendered as a chip beside the value. */
  trend?: Trend;
  polarity?: TrendPolarity;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-dim)' }}>
        <span style={{ color }}>{icon}</span>{label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="tabular-nums text-[24px]" style={{ color: 'var(--text)', fontWeight: 600, letterSpacing: '-0.01em' }}>{value}</span>
        {trend && <TrendChip trend={trend} polarity={polarity} />}
      </div>
      <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-mute)' }}>{sub}</div>
    </div>
  );
}
