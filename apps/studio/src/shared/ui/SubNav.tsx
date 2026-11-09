'use client';

import { useEffect, useRef, type ComponentType, type ReactNode } from 'react';

type IconComponent = ComponentType<{ size?: number; color?: string }>;

/**
 * One entry of a section nav: the highlighted pill shared by the NavPanel
 * sidebar, its mobile bar and the settings bars, so they all look the same.
 *
 * Inside a SubNavBar, becoming active scrolls the pill into the bar's view: a
 * deep link to the eighth section must not leave its pill off-screen right.
 */
export function SubNavPill({ label, icon: Icon, active }: { label: ReactNode; icon?: IconComponent; active: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const pill = ref.current;
    const bar = pill?.closest<HTMLElement>('[data-subnav-bar]');
    if (!active || !pill || !bar) return;
    // Scroll the bar only. `scrollIntoView` would also scroll the page.
    const b = bar.getBoundingClientRect();
    const p = pill.getBoundingClientRect();
    if (p.left < b.left || p.right > b.right) {
      bar.scrollBy({ left: p.left - b.left - (b.width - p.width) / 2, behavior: 'smooth' });
    }
  }, [active]);

  return (
    <span
      ref={ref}
      className="flex items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 py-2 text-[13px] transition-colors"
      style={{ color: active ? 'var(--text)' : 'var(--text-dim)', background: active ? 'var(--accent-soft)' : 'transparent' }}
    >
      {Icon && <Icon size={15} color={active ? 'var(--accent)' : 'currentColor'} />}
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * The mobile section bar: one row of pills that slides sideways instead of
 * stacking every section above the page. Callers hide it at the breakpoint
 * where their desktop nav takes over.
 *
 * `pinned` is for a bar rendered inside a PageShell: it sticks to the top of
 * the scrolling area and bleeds over the shell's side padding (`px-4 sm:px-8`)
 * so it spans the screen like the NavPanel bar does.
 */
export function SubNavBar({
  label,
  pinned = false,
  className = '',
  children,
}: {
  label: string;
  pinned?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <nav
      data-subnav-bar
      aria-label={label}
      className={`flex shrink-0 gap-1 overflow-x-auto px-2 py-2 ${pinned ? 'sticky top-0 z-10 -mx-4 border-y sm:-mx-8' : 'border-b'} ${className}`}
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      {children}
    </nav>
  );
}

export interface SubNavItem<T extends string> {
  id: T;
  label: ReactNode;
  icon?: IconComponent;
}

/** A pinned SubNavBar that switches in-page sections instead of routes. */
export function SubNavTabs<T extends string>({
  label,
  items,
  value,
  onChange,
  className,
}: {
  label: string;
  items: readonly SubNavItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <SubNavBar label={label} pinned className={className}>
      {items.map(({ id, label: itemLabel, icon }) => (
        <button
          key={id}
          type="button"
          aria-current={id === value ? 'true' : undefined}
          onClick={() => onChange(id)}
          className="shrink-0 cursor-pointer"
        >
          <SubNavPill label={itemLabel} icon={icon} active={id === value} />
        </button>
      ))}
    </SubNavBar>
  );
}
