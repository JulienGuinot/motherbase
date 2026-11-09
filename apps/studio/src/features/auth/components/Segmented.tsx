export function Segmented({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { v: string; l: string }[];
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="label">{label}</span>
      <div className="flex overflow-hidden border hairline-strong" style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
        {options.map(o => (
          <button
            key={o.v}
            onClick={() => onChange(o.v)}
            className="px-2.5 py-1 text-[11px]"
            style={{
              background: value === o.v ? 'var(--hover)' : 'transparent',
              color: value === o.v ? 'var(--text)' : 'var(--text-mute)',
            }}
          >
            {o.l}
          </button>
        ))}
      </div>
    </div>
  );
}
