import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronsUpDown, Search } from 'lucide-react';
import {
  filterRows,
  findOption,
  nextEnabled,
  popoverPlacement,
  SEARCH_THRESHOLD,
  toGroups,
  type SelectItems,
  type SelectOption,
} from './select/select-model';
import { SelectGroupCaption, SelectOptionRow } from './select/SelectOptionRow';
import { useSelectPopover } from './select/useSelectPopover';

// Custom Select: replaces the native <select> across the studio. Keeps the
// existing skin (design-system vars only), renders its popover in a portal so
// it is never clipped by an overflow container, and is fully keyboard driven.

export type { SelectGroup, SelectOption } from './select/select-model';

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectItems;
  placeholder?: string;
  /** Small muted tag rendered left of the value inside the trigger (e.g. "schema"). */
  label?: string;
  /** Icon rendered at the very left of the trigger. */
  leadingIcon?: ReactNode;
  /** Show a filter box. Defaults to auto: on when total options > 8. */
  searchable?: boolean;
  disabled?: boolean;
  /** Popover horizontal alignment relative to the trigger. */
  align?: 'left' | 'right';
  /** Extra class on the trigger button. */
  className?: string;
  /** Inline style merged onto the trigger button. */
  style?: CSSProperties;
  ariaLabel?: string;
  /** Lands on the trigger, so a caption's `htmlFor` can point at it. */
  id?: string;
  /**
   * Optional sticky action row pinned to the bottom of the popover (e.g. a
   * "＋ New organization" button). Receives a `close` callback so the action can
   * dismiss the dropdown before opening a modal.
   */
  footer?: ReactNode | ((close: () => void) => ReactNode);
}

const POPOVER_SKIN: CSSProperties = {
  position: 'fixed',
  overflowY: 'auto',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  boxShadow: 'var(--shadow-pop)',
  zIndex: 1000,
  padding: 4,
};

function triggerStyle(disabled: boolean | undefined): CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    minWidth: 0, maxWidth: '100%',
    padding: '6px 8px', fontSize: 13, fontWeight: 500,
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
    transition: 'border-color .15s, background .15s',
  };
}

export default function Select({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  label,
  leadingIcon,
  searchable,
  disabled,
  align = 'left',
  className,
  style,
  ariaLabel,
  id,
  footer,
}: SelectProps) {
  const { open, setOpen, rect, triggerRef, popRef } = useSelectPopover();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => toGroups(options), [options]);
  const showSearch = searchable ?? groups.reduce((n, g) => n + g.options.length, 0) > SEARCH_THRESHOLD;
  const selected = useMemo(() => findOption(groups, value), [groups, value]);
  const { rows, navOptions } = useMemo(() => filterRows(groups, query), [groups, query]);

  useEffect(() => {
    if (!open || !showSearch) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, showSearch]);

  // Keep the highlighted row in view by scrolling the popover only.
  // `scrollIntoView` also scrolls every ancestor, including the `overflow:
  // hidden` document and shell, which the operator cannot scroll back: the page
  // slid out of view and only a reload brought it back.
  useEffect(() => {
    const pop = popRef.current;
    const row = pop?.querySelector<HTMLElement>(`[data-nav="${active}"]`);
    if (!open || !pop || !row) return;
    const p = pop.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (r.top < p.top) pop.scrollTop -= p.top - r.top;
    else if (r.bottom > p.bottom) pop.scrollTop += r.bottom - p.bottom;
  }, [active, open, rows, popRef]);

  const openPopover = () => {
    const selectedIndex = groups.flatMap(group => group.options).findIndex(option => option.value === value);
    setQuery('');
    setActive(Math.max(selectedIndex, 0));
    setOpen(true);
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const commit = (option?: SelectOption) => {
    if (!option || option.disabled) return;
    onChange(option.value);
    close(true);
  };

  const moveActive = (dir: 1 | -1) => {
    if (navOptions.length) setActive(nextEnabled(navOptions, active, dir));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPopover();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); moveActive(1); break;
      case 'ArrowUp': e.preventDefault(); moveActive(-1); break;
      case 'Home': e.preventDefault(); setActive(0); break;
      case 'End': e.preventDefault(); setActive(navOptions.length - 1); break;
      case 'Enter': e.preventDefault(); commit(navOptions[active]); break;
      case 'Escape': e.preventDefault(); close(true); break;
      case 'Tab': close(false); break;
    }
  };

  const popStyle: CSSProperties = rect
    ? { ...POPOVER_SKIN, ...popoverPlacement(rect, align, { width: window.innerWidth, height: window.innerHeight }) }
    : {};

  return (
    <>
      <button
        id={id}
        type="button"
        ref={triggerRef}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ?? label}
        onClick={() => {
          if (disabled) return;
          if (open) setOpen(false);
          else openPopover();
        }}
        onKeyDown={onKeyDown}
        className={className}
        style={{ ...triggerStyle(disabled), ...style }}
        onMouseEnter={e => { if (!disabled) e.currentTarget.style.borderColor = 'var(--border-strong)'; }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}
      >
        {leadingIcon && <span style={{ display: 'inline-flex', color: 'var(--text-mute)', flexShrink: 0 }}>{leadingIcon}</span>}
        {label && <span className="label" style={{ fontSize: 10, flexShrink: 0 }}>{label}</span>}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected ? 'var(--text)' : 'var(--text-mute)' }}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronsUpDown size={12} style={{ color: 'var(--text-mute)', flexShrink: 0, marginLeft: 'auto' }} />
      </button>

      {/* Not before the trigger is measured: without `rect` the popover has no
          position and lands in the document flow, below the shell. */}
      {open && rect && createPortal(
        <div ref={popRef} className="modal-fade" role="listbox" aria-label={ariaLabel ?? label} style={popStyle}>
          {showSearch && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', marginBottom: 2, borderBottom: '1px solid var(--border)' }}>
              <Search size={12} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
              <input
                ref={searchRef}
                value={query}
                onChange={e => { setQuery(e.target.value); setActive(0); }}
                onKeyDown={onKeyDown}
                placeholder="Filter…"
                style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 13 }}
              />
            </div>
          )}

          {rows.length === 0 && (
            <div style={{ padding: '10px 8px', fontSize: 12, color: 'var(--text-mute)', textAlign: 'center' }}>No matches</div>
          )}

          {rows.map((row, i) =>
            row.kind === 'group' ? (
              <SelectGroupCaption key={`g-${row.label}-${i}`} label={row.label} />
            ) : (
              <SelectOptionRow
                key={row.option.value}
                option={row.option}
                navIndex={row.navIndex}
                active={row.navIndex === active}
                selected={row.option.value === value}
                onHover={() => setActive(row.navIndex)}
                onPick={() => commit(row.option)}
              />
            ),
          )}

          {footer && (
            <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid var(--border)' }}>
              {typeof footer === 'function' ? footer(() => setOpen(false)) : footer}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
