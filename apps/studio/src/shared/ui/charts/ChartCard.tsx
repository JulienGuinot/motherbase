import type { ReactNode } from 'react';

// Card wrapper for a chart: title, optional KPI value + delta, and body.
export default function ChartCard({
  title,
  value,
  hint,
  children,
}: {
  title: string;
  value?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[13px]" style={{ color: 'var(--text-dim)', fontWeight: 500 }}>{title}</h3>
        {hint && <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>{hint}</span>}
      </div>
      {value != null && (
        <div className="mt-1 tabular-nums text-[26px]" style={{ color: 'var(--text)', fontWeight: 600, letterSpacing: '-0.01em' }}>
          {value}
        </div>
      )}
      <div className="mt-3">{children}</div>
    </div>
  );
}
