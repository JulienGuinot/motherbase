import type { ComponentType, CSSProperties, ReactNode } from 'react';

// One metric tile for the whole app. Replaces the per-feature StatCard /
// MetricCard / IconStat copies that only differed by a few pixels.
export function StatCard({
  label,
  value,
  icon: Icon,
  color,
  size = 'md',
  className = '',
}: {
  label?: ReactNode;
  value: ReactNode;
  icon?: ComponentType<{ size?: number; style?: CSSProperties }>;
  /** Value colour, for metrics that carry a status (red counts, green uptime). */
  color?: string;
  /** `sm` for dense toolbars, `md` for the standard stat row. */
  size?: 'sm' | 'md';
  className?: string;
}) {
  const compact = size === 'sm';
  return (
    <div className={`card flex items-center gap-3 ${compact ? 'px-4 py-2.5' : 'p-4'} ${className}`}>
      {Icon && <Icon size={compact ? 14 : 16} style={{ color: 'var(--text-mute)' }} />}
      <div className="leading-tight">
        <div
          className={`tabular-nums ${compact ? 'text-[15px]' : 'text-[18px]'} leading-none`}
          style={{ color: color ?? 'var(--text)', fontWeight: 600, letterSpacing: '-0.01em' }}
        >
          {value}
        </div>
        {label && <div className="label mt-1">{label}</div>}
      </div>
    </div>
  );
}

/** Compact bordered metric used inside panels (no card chrome). */
export function StatTile({ label, value, tone = 'neutral' }: { label: ReactNode; value: ReactNode; tone?: 'neutral' | 'good' | 'bad' }) {
  const color = tone === 'bad' ? 'var(--red)' : tone === 'good' ? 'var(--green)' : 'var(--text)';
  return (
    <div className="border hairline px-3 py-2" style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
      <div className="text-[15px] tabular-nums" style={{ color, fontWeight: 600 }}>{value}</div>
      <div className="label mt-1">{label}</div>
    </div>
  );
}
