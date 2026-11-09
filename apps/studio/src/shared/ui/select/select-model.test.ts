import { describe, expect, it } from 'vitest';
import { filterRows, nextEnabled, popoverPlacement, toGroups } from './select-model';

const rect = (left: number, top: number, width = 100, height = 30) =>
  ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;

describe('select model', () => {
  it('drops groups with no match and numbers options for keyboard navigation', () => {
    const groups = toGroups([
      { label: 'A', options: [{ value: '1', label: 'apple' }] },
      { label: 'B', options: [{ value: '2', label: 'banana' }, { value: '3', label: 'apricot' }] },
    ]);
    const { rows, navOptions } = filterRows(groups, 'ap');
    expect(rows.map(r => (r.kind === 'group' ? r.label : r.option.value))).toEqual(['A', '1', 'B', '3']);
    expect(navOptions.map(o => o.value)).toEqual(['1', '3']);
  });

  it('skips disabled options and wraps around', () => {
    const options = [{ value: 'a', label: 'a' }, { value: 'b', label: 'b', disabled: true }, { value: 'c', label: 'c' }];
    expect(nextEnabled(options, 0, 1)).toBe(2);
    expect(nextEnabled(options, 2, 1)).toBe(0);
  });

  it('flips above a trigger near the bottom and keeps the popover on screen', () => {
    const placement = popoverPlacement(rect(350, 760), 'left', { width: 390, height: 800 });
    expect(placement.top).toBeUndefined();
    expect(placement.bottom).toBe(800 - 760 + 6);
    expect(Number(placement.left) + Number(placement.minWidth)).toBeLessThanOrEqual(390 - 8);
  });
});
