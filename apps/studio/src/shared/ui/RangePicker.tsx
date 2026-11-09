import { RANGE_MS } from '@/shared/lib/range';

// Segmented time-range selector shared by Reports and Logs. The key set is a
// parameter: Reports reads an in-memory sample ring (RANGE_MS), Logs reads a
// retained table and offers days as well.
export default function RangePicker<K extends string>({
  value,
  onChange,
  ranges,
}: {
  value: K;
  onChange: (r: K) => void;
  ranges?: Partial<Record<K, number>>;
}) {
  const keys = Object.keys(ranges ?? RANGE_MS) as K[];

  return (
    <div className="flex overflow-hidden border hairline-strong" style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
      {keys.map(k => (
        <button
          key={k}
          onClick={() => onChange(k)}
          className="px-2.5 py-1.5 text-[11px]"
          style={{
            background: value === k ? 'var(--hover)' : 'transparent',
            color: value === k ? 'var(--text)' : 'var(--text-mute)',
          }}
        >
          {k}
        </button>
      ))}
    </div>
  );
}
