import type { ReactNode } from 'react';

// Label + control + help/error, the shape repeated in every form in the studio.
// Renders a <label> so clicking the caption focuses the control inside it.
export function Field({
  label,
  hint,
  error,
  required,
  htmlFor,
  className = '',
  children,
}: {
  label: ReactNode;
  /** The control's id, when the first control inside is not the one to focus (ListInput). */
  htmlFor?: string;
  /** Help text under the control. */
  hint?: ReactNode;
  /** Replaces the hint and turns red when set. */
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className={`block ${className}`}>
      <span className="label mb-1.5 block">
        {label}
        {required && <span style={{ color: 'var(--red)' }}> *</span>}
      </span>
      {children}
      {(error || hint) && (
        <span className="mt-1 block text-[11px]" style={{ color: error ? 'var(--red)' : 'var(--text-mute)' }}>
          {error || hint}
        </span>
      )}
    </label>
  );
}

/** Same caption as Field, for read-only content (code blocks, output, values). */
export function Labeled({
  label,
  hint,
  className = '',
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <div className="label mb-1.5">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11px]" style={{ color: 'var(--text-mute)' }}>{hint}</div>}
    </div>
  );
}

/** Checkbox with its caption, as one clickable row. */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  className = '',
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label className={`flex cursor-pointer items-center gap-2.5 text-[12px] ${className}`} style={{ color: 'var(--text-dim)' }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
