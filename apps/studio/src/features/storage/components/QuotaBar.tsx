import { formatBytes } from '@/shared/lib/format';

export function QuotaBar({ usedBytes, quotaBytes }: { usedBytes: number; quotaBytes: number }) {
  const pct = Math.min(100, (usedBytes / quotaBytes) * 100);
  const color = pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--amber)' : 'var(--green)';
  return (
    <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-mute)' }}>
      <div className="flex-1 h-1.5 overflow-hidden" style={{ background: 'var(--surface-2)', borderRadius: 999 }}>
        <div style={{ width: `${pct}%`, background: color, height: '100%', borderRadius: 999, transition: 'width 0.3s' }} />
      </div>
      <span className="tabular-nums shrink-0">{formatBytes(usedBytes)} / {formatBytes(quotaBytes)}</span>
    </div>
  );
}