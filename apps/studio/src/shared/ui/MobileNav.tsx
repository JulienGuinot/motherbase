'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { Menu, X } from 'lucide-react';
import { NavLink } from '@/shared/ui/NavLink';
import { useDialogBehavior } from '@/shared/hooks/useDialogBehavior';

type IconType = React.ComponentType<{ size?: number; color?: string }>;

export interface MobileNavItem {
  href: string;
  label: string;
  icon: IconType;
  /** Exact-match only, for a parent entry that would stay lit on every child. */
  end?: boolean;
}

/**
 * The only navigation on small screens: a pill fixed at the bottom centre of
 * the viewport, opening the full product list as a sheet from the bottom. The
 * topbar scrolls out of reach on a phone, so a menu button living there meant
 * scrolling back to the top before going anywhere.
 *
 * `action` fills the pill's right half (the assistant launcher, in a project),
 * so the one floating control owns the whole bottom of the screen instead of
 * two colliding with each other.
 *
 * Absolute, not fixed: render it as a direct child of a `relative` shell that
 * fills the viewport. Safari 26 paints a solid band under its toolbar, in place
 * of the translucent one, whenever a *fixed* element sits near the bottom edge,
 * and whether the pill counted depended on the toolbar's state. The shells never
 * scroll the document, so an absolute pill lands in exactly the same place
 * without tripping that heuristic.
 */
export default function MobileNav({
  items,
  title,
  footer,
  action,
}: {
  items: MobileNavItem[];
  title: string;
  footer?: ReactNode;
  action?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <div
        className="absolute bottom-[calc(0.75rem+env(safe-area-inset-bottom))] left-1/2 z-40 flex -translate-x-1/2 items-stretch divide-x divide-[var(--hairline)] overflow-hidden rounded-full border shadow-lg md:hidden"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          aria-expanded={open}
          className="flex items-center gap-2 px-4 py-2.5 text-[13px] font-medium"
          style={{ color: 'var(--text)' }}
        >
          <Menu size={16} /> Menu
        </button>
        {action}
      </div>

      {open && (
        <NavSheet title={title} footer={footer} onClose={close}>
          {items.map(({ href, label, icon: Icon, end }) => (
            <li key={href}>
              <NavLink
                href={href}
                end={end}
                onClick={close}
                className="flex items-center gap-3 rounded-md px-3 py-2.5 text-[14px]"
                style={({ isActive }) => ({
                  color: isActive ? 'var(--text)' : 'var(--text-dim)',
                  background: isActive ? 'var(--accent-soft)' : 'transparent',
                  fontWeight: isActive ? 600 : 400,
                })}
              >
                {({ isActive }) => (
                  <>
                    <Icon size={17} color={isActive ? 'var(--accent)' : 'currentColor'} />
                    <span className="truncate">{label}</span>
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </NavSheet>
      )}
    </>
  );
}

/** Mounted only while open, so the dialog contract (Escape, focus trap, frozen
 *  page scroll) applies exactly for the sheet's lifetime. */
function NavSheet({
  title,
  footer,
  onClose,
  children,
}: {
  title: string;
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const sheetRef = useDialogBehavior(onClose);

  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <button
        type="button"
        aria-label="Close navigation"
        onClick={onClose}
        className="modal-scrim modal-fade absolute inset-0"
      />
      <nav
        ref={sheetRef}
        aria-label={title}
        className="modal-rise absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-2xl border-t shadow-xl"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
      >
        <div className="flex shrink-0 items-center gap-2 border-b py-2 pl-4 pr-2" style={{ borderColor: 'var(--border)' }}>
          <span className="flex-1 truncate text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
            {title}
          </span>
          <button type="button" onClick={onClose} aria-label="Close navigation" className="btn btn-ghost">
            <X size={18} />
          </button>
        </div>

        <ul className="flex-1 space-y-0.5 overflow-y-auto p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
          {children}
        </ul>

        {footer && (
          <div className="shrink-0 border-t p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]" style={{ borderColor: 'var(--border)' }}>
            {footer}
          </div>
        )}
      </nav>
    </div>
  );
}
