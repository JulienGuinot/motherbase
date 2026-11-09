import type { CSSProperties, ReactNode } from 'react';

// Title block for a page or a panel. Three sizes cover every heading in the app:
//   lg  hero pages (Projects, Object store)
//   md  console pages (Team, Usage, Billing, project Overview)
//   sm  panel and sidebar headings (Tables, Functions, Observability)
type Size = 'sm' | 'md' | 'lg';

// Tracking and weight come from `.display-heading`. Sizes stay small: on a
// console the title is the least useful thing on screen.
const TITLE: Record<Size, string> = {
  sm: 'text-[14px]',
  md: 'text-[18px]',
  lg: 'text-[20px] leading-tight sm:text-[22px]',
};

export function PageHeader({
  title,
  subtitle,
  actions,
  size = 'lg',
  wrap = true,
  children,
  className = '',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  size?: Size;
  wrap?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  // `sm` is a panel or sidebar heading sitting inside a page that already has a
  // title, so it ranks as h2, keeping one h1 per page for screen readers.
  const Title = size === 'sm' ? 'h2' : 'h1';
  return (
    // `items-start`, not `items-end`: the actions belong on the title's line.
    <header className={`flex ${wrap ? 'flex-wrap' : ''} items-start justify-between gap-3 sm:gap-4 ${className}`}>
      <div className="min-w-0">
        <Title className={`display-heading ${TITLE[size]}`} style={{ color: 'var(--text)' }}>
          {title}
        </Title>
        {subtitle && (
          <p className="mt-1 max-w-xl text-[13px]" style={{ color: 'var(--text-dim)' }}>
            {subtitle}
          </p>
        )}
        {children}
      </div>
      {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

// Console pages read as prose and forms, so they stay in a centred column: past
// ~1100px a line of settings text is harder to scan, not easier. Data-heavy
// console pages (Logs, Observability, Cron) get `wide` because their value is in
// the table columns, and `full` exists for pages that already own their gutters.
const SHELL_WIDTH = {
  default: 'max-w-5xl',
  wide: 'max-w-[1400px]',
  full: 'max-w-none',
} as const;

export type ShellWidth = keyof typeof SHELL_WIDTH;

/** Standard console page frame: outer padding, centered column, section rhythm. */
export function PageShell({
  children,
  width = 'default',
  className = '',
}: {
  children: ReactNode;
  width?: ShellWidth;
  className?: string;
}) {
  return (
    <div className="px-4 py-5 sm:px-8 sm:py-7">
      <div className={`rise mx-auto ${SHELL_WIDTH[width]} space-y-6 ${className}`}>{children}</div>
    </div>
  );
}

// `responsive` is the sidebar-plus-panel case: side by side on desktop, stacked
// and scrollable on mobile. `row` keeps the split at every width (SQL, where the
// editor and the snippet list are useless stacked). `column` is a single stack
// that owns its own scrolling.
const WORKBENCH_LAYOUT = {
  responsive: 'flex-col overflow-auto md:flex-row md:overflow-hidden',
  row: 'flex-row overflow-hidden',
  column: 'flex-col overflow-hidden',
} as const;

export type WorkbenchLayout = keyof typeof WORKBENCH_LAYOUT;

/**
 * Frame for the workbench pages (Tables, SQL, Functions, Edge Functions, API
 * explorer). These fill the viewport and own their scrolling, so the page must
 * not add outer padding: the sidebar and the result panel scroll independently
 * while the frame itself stays put.
 */
export function WorkbenchShell({
  children,
  layout = 'responsive',
  className = '',
  style,
}: {
  children: ReactNode;
  layout?: WorkbenchLayout;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`rise flex min-h-0 flex-1 border hairline ${WORKBENCH_LAYOUT[layout]} ${className}`}
      style={{ background: 'var(--surface)', ...style }}
    >
      {children}
    </div>
  );
}
