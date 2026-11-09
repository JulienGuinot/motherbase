import type { CSSProperties } from 'react';

/**
 * The "the model is working" indicator. Reserved for AI-driven waits
 * (assistant answers, tool calls) so it stays a distinct signal from the
 * app's ordinary loading chrome: `Skeleton`, `RouteLoading` and the topbar
 * `FetchProgress` cover data that is merely in flight.
 *
 * Pure CSS (see `.thinking-orb` in index.css), so it costs no dependency and
 * the global reduce-motion block pins it to a single static frame.
 */
export function ThinkingOrb({
  size = 14,
  label,
  className = '',
  style,
}: {
  size?: number;
  /** Announce the wait. Omit when visible text beside it already says it. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={`thinking-orb ${className}`}
      style={{ width: size, height: size, ...style }}
      {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
    />
  );
}

export default ThinkingOrb;
