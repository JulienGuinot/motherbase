import { Check } from 'lucide-react';
import type { SelectOption } from './select-model';

export function SelectGroupCaption({ label }: { label: string }) {
  return (
    <div className="label" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.04em', padding: '6px 8px 2px' }}>
      {label}
    </div>
  );
}

export function SelectOptionRow({
  option,
  navIndex,
  active,
  selected,
  onHover,
  onPick,
}: {
  option: SelectOption;
  navIndex: number;
  active: boolean;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-disabled={option.disabled}
      data-nav={navIndex}
      onMouseEnter={() => !option.disabled && onHover()}
      onClick={onPick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 8px', fontSize: 13, borderRadius: 'var(--radius-sm)',
        cursor: option.disabled ? 'not-allowed' : 'pointer',
        color: option.disabled ? 'var(--text-mute)' : 'var(--text)',
        background: active && !option.disabled ? 'var(--hover)' : 'transparent',
      }}
    >
      {option.icon && <span style={{ display: 'inline-flex', color: 'var(--text-mute)', flexShrink: 0 }}>{option.icon}</span>}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.label}</span>
      {selected && <Check size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
    </div>
  );
}
