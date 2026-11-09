interface CellValueProps {
  value: unknown;
  type: string;
}

export function CellValue({ value, type }: CellValueProps) {
  if (value === null || value === undefined) {
    return <span className="mono text-[11px]" style={{ color: 'var(--paper-mute)' }}>NULL</span>;
  }
  if (type === 'Boolean') {
    return (
      <span className="chip" style={{ color: value ? 'var(--text)' : 'var(--text-mute)' }}>
        {value ? 'true' : 'false'}
      </span>
    );
  }
  if (type === 'DateTime') {
    return <span className="text-[12px] tabular-nums">{new Date(String(value)).toLocaleString()}</span>;
  }
  if (typeof value === 'object') {
    return <span className="mono text-[11px]" style={{ color: 'var(--text-dim)' }}>{JSON.stringify(value)}</span>;
  }
  return <span>{String(value)}</span>;
}