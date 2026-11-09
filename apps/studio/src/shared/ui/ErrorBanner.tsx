import { AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';

/** Inline failure notice for a form or a page action. */
export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex items-start gap-3 border px-4 py-3"
      style={{
        borderColor: 'color-mix(in srgb, var(--red) 42%, transparent)',
        background: 'color-mix(in srgb, var(--red) 10%, var(--surface))',
        borderRadius: 'var(--radius-md)',
      }}
      role="alert"
    >
      <AlertCircle size={16} style={{ color: 'var(--red)', marginTop: 1, flexShrink: 0 }} />
      <span className="text-[13px] leading-5" style={{ color: 'var(--red)' }}>
        {children}
      </span>
    </div>
  );
}
