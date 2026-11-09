export function Cell({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className="mono text-[11px]" style={{ color: 'var(--paper-mute)' }}>NULL</span>;
  if (typeof v === 'object') return <span className="mono text-[11px]" style={{ color: 'var(--text-dim)' }}>{JSON.stringify(v)}</span>;
  return <span>{String(v)}</span>;
}
