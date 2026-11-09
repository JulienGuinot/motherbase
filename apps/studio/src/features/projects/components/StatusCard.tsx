import type { LucideIcon } from 'lucide-react';

// Compact Supabase-style status tile: an icon, an uppercase label, and a value
// (or an honest empty state). Optionally clickable to deep-link into a section.
export function StatusCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'default',
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'ok' | 'warn' | 'danger' | 'muted';
  onClick?: () => void;
}) {
  const color =
    tone === 'ok' ? 'var(--green)'
    : tone === 'warn' ? 'var(--amber)'
    : tone === 'danger' ? 'var(--red)'
    : tone === 'muted' ? 'var(--text-mute)'
    : 'var(--text)';

  const inner = (
    <>
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border hairline"
        style={{ background: 'var(--surface-2)' }}
      >
        <Icon size={16} style={{ color }} />
      </span>
      <div className="min-w-0">
        <div className="label">{label}</div>
        <div className="mt-0.5 truncate text-[15px]" style={{ color, fontWeight: 600, letterSpacing: '-0.01em' }}>
          {value}
        </div>
        {hint && <div className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-mute)' }}>{hint}</div>}
      </div>
    </>
  );

  // min-w-0 on the card itself, not just on the text inside it. As a grid item
  // its default min-width is auto, which is the min-content of its widest
  // child: one long value (a migration name, a project URL) then set the width
  // of the whole track and pushed every card in the row off a phone screen.
  // The truncate inside can only do its job once the card may shrink.
  const className = 'flex min-w-0 items-center gap-3 rounded-lg border hairline p-3 text-left';
  if (onClick) {
    return (
      <button onClick={onClick} className={`${className} w-full transition-colors hover:bg-[var(--surface-2)]`} style={{ background: 'var(--surface-1)' }}>
        {inner}
      </button>
    );
  }
  return <div className={className} style={{ background: 'var(--surface-1)' }}>{inner}</div>;
}
