import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'success' | 'warn' | 'danger' | 'info';

const TONE_COLOR: Record<Tone, string> = {
  neutral: 'var(--text-mute)',
  success: 'var(--green)',
  warn: 'var(--amber)',
  danger: 'var(--red)',
  info: 'var(--accent)',
};

// Status pill built on the `chip` class so every badge in the app shares one
// shape. Use tones, not raw Tailwind colours: tones follow the theme tokens.
export function Badge({
  children,
  tone = 'neutral',
  dot = false,
  className = '',
}: {
  children: ReactNode;
  tone?: Tone;
  /** Show the leading status dot. */
  dot?: boolean;
  className?: string;
}) {
  const color = TONE_COLOR[tone];
  return (
    <span className={`chip ${className}`} style={{ color }}>
      {dot && <span className="dot" style={{ background: color }} />}
      {children}
    </span>
  );
}

/** Bare status dot, for rows too dense for a full badge. */
export function StatusDot({ tone = 'neutral', size = 10 }: { tone?: Tone; size?: number }) {
  return <span aria-hidden style={{ color: TONE_COLOR[tone], fontSize: size }}>●</span>;
}
