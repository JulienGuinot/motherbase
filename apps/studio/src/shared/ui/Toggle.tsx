/** Accessible pill switch. The only switch in the app: never re-roll this markup. */
export function Toggle({
  id,
  checked,
  onChange,
  disabled,
  ariaLabel,
}: {
  id?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex shrink-0 items-center rounded-full transition-colors"
      style={{
        width: 34,
        height: 20,
        background: checked ? 'var(--accent)' : 'var(--surface-3, var(--border))',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <span
        className="inline-block rounded-full bg-white transition-transform"
        style={{
          width: 14,
          height: 14,
          transform: checked ? 'translateX(16px)' : 'translateX(3px)',
          boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
        }}
      />
    </button>
  );
}

/** A labelled toggle row inside a Section. Rows stack with hairline separators. */
export function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-t hairline py-3.5 first:border-t-0 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-[13px]" style={{ color: 'var(--text)' }}>{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>{hint}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} ariaLabel={label} />
    </div>
  );
}
