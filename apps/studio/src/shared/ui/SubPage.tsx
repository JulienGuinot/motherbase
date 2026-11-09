import type { ReactNode } from 'react';

// Page shell for a second-level page (one that sits beside a secondary nav).
// Scaled smaller than the top-level PageHeader, and owns the page padding and
// the vertical rhythm between sections so pages don't each invent their own.
export function SubPage({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rise mx-auto w-full px-4 py-5 sm:px-6 sm:py-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[18px]" style={{ color: 'var(--text)', fontWeight: 600, letterSpacing: '-0.01em' }}>
            {title}
          </h1>
          {description && (
            <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: 'var(--text-dim)', maxWidth: '62ch' }}>
              {description}
            </p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className="mt-7 space-y-5">{children}</div>
    </div>
  );
}
