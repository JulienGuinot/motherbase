import type React from 'react';

export function UsageMeter({ icon: Icon, label, percent, value, limit, hasQuota }: {
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  label: string;
  percent: number;
  value: string;
  limit: string;
  hasQuota: boolean;
}) {
  const pct = Math.max(0, Math.min(100, percent));
  const color = pct >= 90 ? 'var(--red)' : pct >= 75 ? 'var(--amber)' : 'var(--accent)';
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--text-mute)' }}>
        <span className="flex items-center gap-1.5"><Icon size={11} /> {label}</span>
        <span className="tabular-nums">{value} / {limit}</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden" style={{ background: 'var(--surface-2)', borderRadius: 999 }}>
        <div
          className="h-full transition-all"
          style={{ width: `${Math.max(2, pct)}%`, background: hasQuota ? color : 'var(--text-mute)', borderRadius: 999 }}
        />
      </div>
    </div>
  );
}
