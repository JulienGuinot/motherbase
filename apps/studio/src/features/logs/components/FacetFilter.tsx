import { useRef, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { Popover } from '@/shared/ui/Popover';

export interface FacetOption {
  value: string;
  count: number;
  color?: string;
}

// Multi-select facet with per-value counts (Supabase-style). Empty selection
// means "all". Renders a dropdown button + checkbox popover.
export default function FacetFilter({
  label,
  options,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  options: FacetOption[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const active = selected.size > 0;

  return (
    <>
      <button
        ref={button}
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 border hairline-strong px-2.5 py-1.5 text-[11px]"
        style={{
          background: active ? 'var(--hover)' : 'var(--surface-2)',
          color: active ? 'var(--text)' : 'var(--text-mute)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        <span className="capitalize">{label}</span>
        {active && (
          <span
            className="tabular-nums"
            style={{ color: 'var(--accent)', fontWeight: 600 }}
          >
            {selected.size}
          </span>
        )}
        <ChevronDown size={11} style={{ opacity: 0.6 }} />
      </button>

      {open && (
        <Popover anchor={button} onClose={() => setOpen(false)} width={200}>
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="label" style={{ fontSize: 10 }}>{label}</span>
            {active && (
              <button onClick={onClear} className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-mute)' }}>
                <X size={10} /> clear
              </button>
            )}
          </div>
          {options.length === 0 && (
            <p className="px-3 py-2 text-[11px]" style={{ color: 'var(--text-mute)' }}>No values.</p>
          )}
          {options.map(opt => {
            const on = selected.has(opt.value);
            return (
              <button
                key={opt.value}
                onClick={() => onToggle(opt.value)}
                className="nav-item flex w-full items-center gap-2 px-3 py-1.5 text-[12px]"
                style={{ color: 'var(--text-dim)' }}
              >
                <span
                  className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border"
                  style={{
                    borderColor: on ? 'var(--accent)' : 'var(--border)',
                    background: on ? 'var(--accent)' : 'transparent',
                  }}
                >
                  {on && <Check size={10} color="var(--accent-fg)" />}
                </span>
                <span className="flex-1 truncate text-left capitalize" style={{ color: opt.color ?? 'inherit' }}>{opt.value}</span>
                <span className="tabular-nums text-[10px]" style={{ color: 'var(--text-mute)' }}>{opt.count}</span>
              </button>
            );
          })}
        </Popover>
      )}
    </>
  );
}
