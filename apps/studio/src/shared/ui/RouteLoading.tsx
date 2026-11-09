import { LoaderCircle } from 'lucide-react';

export function RouteLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-40 items-center justify-center gap-2 text-sm"
      style={{ color: 'var(--text-dim)' }}
    >
      <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />
      <span>Loading page…</span>
    </div>
  );
}
