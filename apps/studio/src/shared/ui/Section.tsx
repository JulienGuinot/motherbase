import type { ReactNode } from 'react';

// A card with an optional header (title / description / actions) and footer bar.
// This is the standard container for a block of settings or a row list; prefer it
// over hand-rolling `card` markup so every section lines up across features.
export function Section({
  title,
  description,
  actions,
  footer,
  flush,
  tone,
  titleId,
  className = '',
  bodyClassName = '',
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Render children with no inner padding (for full-bleed row lists). */
  flush?: boolean;
  /** `danger` tints the border, for destructive settings groups. */
  tone?: 'danger';
  /** Id for the title, which then labels the section for assistive tech. */
  titleId?: string;
  className?: string;
  /** Extra classes on the padded body, e.g. `space-y-3` for stacked rows. */
  bodyClassName?: string;
  children?: ReactNode;
}) {
  const hasHeader = title || actions;
  return (
    <section
      className={`card overflow-hidden p-0 ${className}`}
      aria-labelledby={titleId}
      style={tone === 'danger' ? { borderColor: 'color-mix(in srgb, var(--red) 30%, transparent)' } : undefined}
    >
      {hasHeader && (
        <div className={`flex items-start justify-between gap-4 px-5 pt-5 ${flush ? 'pb-4' : ''}`}>
          <div>
            {title && <h2 id={titleId} className="text-[13px]" style={{ color: 'var(--text)', fontWeight: 600 }}>{title}</h2>}
            {description && (
              <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-mute)', maxWidth: '58ch' }}>
                {description}
              </p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children != null && (flush
        ? <div className={hasHeader ? 'border-t hairline' : ''}>{children}</div>
        : <div className={`px-5 ${hasHeader ? 'pb-5 pt-4' : 'py-5'} ${bodyClassName}`}>{children}</div>)}
      {footer && (
        <div className="flex items-center justify-end gap-3 border-t hairline px-5 py-3" style={{ background: 'var(--surface-2)' }}>
          {footer}
        </div>
      )}
    </section>
  );
}
