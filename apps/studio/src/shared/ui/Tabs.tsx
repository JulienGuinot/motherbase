// Tab strip only: role=tablist, roving tabindex and arrow-key navigation.
// No `aria-controls` on the tabs, because no screen renders a matching
// role="tabpanel" element: pointing at an id that does not exist is an
// invalid ARIA reference, which is worse than omitting the attribute. Add it
// back together with real panels if the content ever gets a stable wrapper.
import { useRef, type ComponentType, type KeyboardEvent, type ReactNode } from 'react';

// Structural rather than `LucideIcon`: some pages keep their icons in a meta map
// typed only by the props they pass, and those are still valid tab icons.
type IconComponent = ComponentType<{ size?: number }>;

export type TabItem<T extends string> = {
  id: T;
  label: ReactNode;
  icon?: IconComponent;
  /** Count or status shown after the label, e.g. a number of open issues. */
  badge?: ReactNode;
};

/**
 * The underlined tab strip used to switch views inside a page (Object store,
 * API, Realtime, Advisor, Org settings). It was re-rolled on each of those
 * pages with slightly different padding, weight and colours, and none of the
 * copies were reachable by keyboard.
 *
 * This one is a real tablist: arrow keys move between tabs, Home / End jump to
 * the ends, and the selected tab is announced. Panels stay the caller's job,
 * so pages keep rendering `{tab === 'x' && <Panel />}` as before.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className = '',
  size = 'md',
}: {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  size?: 'sm' | 'md';
}) {
  const stripRef = useRef<HTMLDivElement>(null);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const index = items.findIndex(t => t.id === value);
    const last = items.length - 1;
    const next =
      e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : e.key === 'ArrowLeft' ? (index <= 0 ? last : index - 1)
      : (index >= last ? 0 : index + 1);
    onChange(items[next].id);
    // Follow focus, so the keyboard user lands on the tab they just selected.
    stripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  const pad = size === 'sm' ? 'px-3 py-1.5 text-[12px]' : 'px-3 py-2 text-[13px]';

  return (
    <div
      ref={stripRef}
      role="tablist"
      onKeyDown={onKeyDown}
      className={`flex gap-1 overflow-x-auto border-b hairline ${className}`}
    >
      {items.map(({ id, label, icon: Icon, badge }) => {
        const selected = id === value;
        return (
          <button
            key={id}
            role="tab"
            type="button"
            id={`tab-${id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            className={`flex shrink-0 items-center gap-2 whitespace-nowrap transition-colors ${pad}`}
            style={{
              color: selected ? 'var(--text)' : 'var(--text-mute)',
              borderBottom: `2px solid ${selected ? 'var(--accent)' : 'transparent'}`,
              fontWeight: selected ? 600 : 400,
              cursor: 'pointer',
            }}
          >
            {Icon && <Icon size={14} />}
            {label}
            {badge != null && badge}
          </button>
        );
      })}
    </div>
  );
}
