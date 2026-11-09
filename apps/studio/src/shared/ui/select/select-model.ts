import type { CSSProperties, ReactNode } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SelectGroup {
  label: string;
  options: SelectOption[];
}

export type SelectItems = SelectOption[] | SelectGroup[];

/** One rendered line of the popover: a group caption, or an option with its keyboard index. */
export type SelectRow =
  | { kind: 'group'; label: string }
  | { kind: 'option'; option: SelectOption; navIndex: number };

/** Options above this count get a filter box unless `searchable` says otherwise. */
export const SEARCH_THRESHOLD = 8;

export function toGroups(items: SelectItems): SelectGroup[] {
  const grouped = items.length > 0 && (items as SelectGroup[])[0].options !== undefined;
  return grouped ? (items as SelectGroup[]) : [{ label: '', options: items as SelectOption[] }];
}

export function findOption(groups: SelectGroup[], value: string): SelectOption | undefined {
  for (const group of groups) {
    const found = group.options.find(o => o.value === value);
    if (found) return found;
  }
  return undefined;
}

/**
 * The rows to render for a filter query, and the options keyboard navigation
 * walks through (`navIndex` is a position in that list). Empty groups vanish.
 */
export function filterRows(groups: SelectGroup[], query: string): { rows: SelectRow[]; navOptions: SelectOption[] } {
  const q = query.trim().toLowerCase();
  const rows: SelectRow[] = [];
  const navOptions: SelectOption[] = [];
  for (const group of groups) {
    const matched = q ? group.options.filter(o => o.label.toLowerCase().includes(q)) : group.options;
    if (matched.length === 0) continue;
    if (group.label) rows.push({ kind: 'group', label: group.label });
    for (const option of matched) {
      rows.push({ kind: 'option', option, navIndex: navOptions.length });
      navOptions.push(option);
    }
  }
  return { rows, navOptions };
}

/** The next enabled option index in `dir`, wrapping around; `from` when every option is disabled. */
export function nextEnabled(options: SelectOption[], from: number, dir: 1 | -1): number {
  let i = from;
  for (let step = 0; step < options.length; step++) {
    i = (i + dir + options.length) % options.length;
    if (!options[i]?.disabled) return i;
  }
  return i;
}

const MIN_POPOVER_WIDTH = 180;
const MAX_POPOVER_WIDTH = 360;
const EDGE = 8;

/**
 * Where the fixed popover goes for a trigger at `rect`: below it, or above
 * when there is clearly more room there.
 *
 * The popover is at least 180px wide whatever the trigger is, so on a phone
 * a trigger sitting past the middle of the screen pushed it off the right
 * edge: min-width beats max-width, so clamping the width could not save it.
 * Clamp the ANCHOR instead, on whichever side it is anchored from.
 */
export function popoverPlacement(
  rect: DOMRect,
  align: 'left' | 'right',
  viewport: { width: number; height: number },
): CSSProperties {
  const width = Math.min(Math.max(rect.width, MIN_POPOVER_WIDTH), Math.max(160, viewport.width - 2 * EDGE));
  const spaceBelow = viewport.height - rect.bottom;
  const flipUp = spaceBelow < 240 && rect.top > spaceBelow;
  const clamp = (offset: number) => Math.max(EDGE, Math.min(offset, viewport.width - width - EDGE));
  return {
    left: align === 'right' ? undefined : clamp(rect.left),
    right: align === 'right' ? clamp(viewport.width - rect.right) : undefined,
    top: flipUp ? undefined : rect.bottom + 6,
    bottom: flipUp ? viewport.height - rect.top + 6 : undefined,
    minWidth: width,
    maxWidth: Math.min(MAX_POPOVER_WIDTH, viewport.width - 2 * EDGE),
    maxHeight: Math.max(160, (flipUp ? rect.top : spaceBelow) - 16),
  };
}
