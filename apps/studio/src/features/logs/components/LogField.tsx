export function LogField({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="mono mt-0.5 break-all" style={{ color: tone ?? 'var(--text-dim)' }}>{value}</div>
    </div>
  );
}
