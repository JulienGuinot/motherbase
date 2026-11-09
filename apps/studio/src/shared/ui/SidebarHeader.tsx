import type { ReactNode } from 'react';

// Header of a list sidebar (tables, functions, models, edge functions): the
// heading, its inline actions, and an optional second row for a schema picker
// or a search box. One component so every sidebar keeps the same padding.
export function SidebarHeader({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="border-b hairline px-3 py-3">
      <div className="flex items-center gap-2">
        <h1 className="text-[15px]" style={{ color: 'var(--text)', fontWeight: 600, letterSpacing: '-0.01em' }}>
          {title}
        </h1>
        {actions && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}
