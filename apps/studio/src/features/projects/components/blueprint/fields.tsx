import type { InputHTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

const INPUT_CLASS_NAME =
  'w-full border hairline px-3 py-3 pl-10 text-[13px] outline-none transition-[border-color,background] focus:border-[var(--accent)] disabled:opacity-50 rounded-[var(--radius-sm)]';
const INPUT_STYLE = { background: 'var(--surface)', color: 'var(--text)' };

export const REQUIRED_MARK = <span style={{ color: 'var(--accent)' }}>*</span>;

/** A numbered step of the form: its title, what it is for, and a status on the right. */
export function SectionHeading({ title, description, aside }: { title: ReactNode; description: string; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <span className="inline-flex items-center gap-2 text-[13px]" style={{ color: 'var(--text-dim)', fontWeight: 600 }}>{title}</span>
        <p className="mt-1 text-[12px]" style={{ color: 'var(--text-mute)' }}>{description}</p>
      </div>
      {aside}
    </div>
  );
}

/** The field name on the left and a short state ("required", "custom"…) on the right. */
export function FieldLabel({ label, aside, asideColor = 'var(--text-mute)' }: { label: ReactNode; aside?: ReactNode; asideColor?: string }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <span className="text-[12px]" style={{ color: 'var(--text-dim)', fontWeight: 500 }}>{label}</span>
      {aside !== undefined && <span className="text-[11px] tabular-nums break-all text-right" style={{ color: asideColor }}>{aside}</span>}
    </div>
  );
}

export function IconInput({
  icon: Icon,
  iconColor = 'var(--text-mute)',
  mono,
  ...input
}: { icon: LucideIcon; iconColor?: string; mono?: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="relative">
      <Icon size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: iconColor }} />
      <input {...input} className={mono ? `${INPUT_CLASS_NAME} mono` : INPUT_CLASS_NAME} style={INPUT_STYLE} />
    </div>
  );
}

export function FieldHint({ children, color = 'var(--text-mute)' }: { children: ReactNode; color?: string }) {
  return <p className="mt-2 text-[11px] leading-5" style={{ color }}>{children}</p>;
}
