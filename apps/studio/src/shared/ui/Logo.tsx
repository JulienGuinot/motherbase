import type { CSSProperties } from 'react';

// Motherbase wordmark mock. The brand mark is a hand-drawn brush "M"; instead of
// a fixed PNG (which can't invert for dark mode) we render the glyph in the
// display font (Gaegu) and inherit `var(--text)`, so it flips automatically
// between light and dark themes. Callers place it inside their own badge/chip.
type LogoProps = {
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** Override the glyph color. Defaults to var(--text) so it inverts with the theme. */
  color?: string;
  title?: string;
};

export default function Logo({
  size = 18,
  className,
  style,
  color = 'var(--text)',
  title = 'Motherbase',
}: LogoProps) {
  return (
    <span
      className={className}
      role="img"
      aria-label={title}
      title={title}
      style={{
        fontFamily: 'var(--font-display)',
        fontWeight: 700,
        fontSize: size,
        lineHeight: 1,
        color,
        display: 'inline-block',
        letterSpacing: '-0.03em',
        transform: 'translateY(-0.04em)',
        userSelect: 'none',
        ...style,
      }}
    >
      M
    </span>
  );
}
