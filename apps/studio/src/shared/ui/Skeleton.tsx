import type { CSSProperties } from 'react';

// Shared loading placeholder. Delegates its look to the `.shimmer` class so the
// component form and the many bare `<div className="shimmer" />` usages across
// the app stay the same shape of grey. Compose several to mirror a real layout.
export function Skeleton({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return <div className={`shimmer ${className}`} style={style} aria-hidden />;
}

/**
 * A stack of placeholder rows, the shape 27 files were each rebuilding with
 * their own `Array.from({ length: n }).map(...)` loop.
 */
export function SkeletonList({
  rows = 3,
  height = 40,
  className = '',
}: {
  rows?: number;
  height?: number;
  className?: string;
}) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} style={{ height }} />
      ))}
    </div>
  );
}
