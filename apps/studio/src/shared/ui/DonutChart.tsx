export interface DonutSlice {
  label: string;
  value: number;
  color: string;
}

export function DonutChart({
  slices,
  size = 120,
  thickness = 16,
  centerLabel,
  centerValue,
}: {
  slices: DonutSlice[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
}) {
  const total = slices.reduce((s, d) => s + d.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  // A 2px gap of the track colour keeps neighbouring slices of close hues from
  // reading as one band. Only taken off slices wide enough to keep a body,
  // otherwise a sliver would vanish into its own gap.
  const GAP = 2;
  let offset = 0;

  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--surface-2)"
          strokeWidth={thickness}
        />
        {total > 0 && slices.map((s, i) => {
          const frac = s.value / total;
          const span = frac * circumference;
          const dashOffset = -offset;
          offset += span;
          if (frac <= 0) return null;
          const dash = slices.length > 1 && span > GAP * 2 ? span - GAP : span;
          return (
            <circle
              key={`${s.label}-${i}`}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={s.color}
              strokeWidth={thickness}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={dashOffset}
              strokeLinecap="butt"
            />
          );
        })}
        {total === 0 && (
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--border)" strokeWidth={thickness} />
        )}
      </svg>
      {(centerLabel || centerValue) && (
        <div className="flex flex-col">
          {centerValue && <span className="text-[20px] tabular-nums" style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>{centerValue}</span>}
          {centerLabel && <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>{centerLabel}</span>}
        </div>
      )}
    </div>
  );
}

export function DonutLegend({ slices }: { slices: DonutSlice[] }) {
  const total = slices.reduce((s, d) => s + d.value, 0);
  return (
    <ul className="space-y-1.5">
      {slices.map((s, i) => (
        <li key={`${s.label}-${i}`} className="flex items-center gap-2 text-[12px]">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
          <span className="truncate" style={{ color: 'var(--text-dim)' }}>{s.label}</span>
          <span className="ml-auto tabular-nums" style={{ color: 'var(--text-mute)' }}>
            {total > 0 ? `${((s.value / total) * 100).toFixed(0)}%` : '0%'}
          </span>
        </li>
      ))}
      {slices.length === 0 && (
        <li className="text-[12px]" style={{ color: 'var(--text-mute)' }}>No data yet.</li>
      )}
    </ul>
  );
}
