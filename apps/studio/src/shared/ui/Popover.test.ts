import { describe, expect, it } from 'vitest';
import { popoverPlacement } from '@/shared/ui/Popover';

const phone = { width: 390, height: 844 };
const button = (left: number, top: number, width = 100) => ({ left, right: left + width, top, bottom: top + 32 });

describe('popoverPlacement', () => {
  it('keeps an end-aligned panel on screen when its button sits near the left edge', () => {
    // The Columns button on a phone: right-aligned, the 210px panel used to start at x = -82.
    expect(popoverPlacement(button(28, 300), phone, 210, 'end')).toMatchObject({ left: 8, width: 210, top: 336 });
  });

  it('keeps a start-aligned panel from running off the right edge', () => {
    expect(popoverPlacement(button(300, 300, 60), phone, 200, 'start').left).toBe(182);
  });

  it('narrows a panel wider than the screen', () => {
    expect(popoverPlacement(button(0, 300), phone, 500, 'start')).toMatchObject({ left: 8, width: 374 });
  });

  it('opens upwards when the button is near the bottom', () => {
    const placement = popoverPlacement(button(20, 760), phone, 210, 'start');
    expect(placement.top).toBeUndefined();
    expect(placement).toMatchObject({ bottom: 88, maxHeight: 748 });
  });
});
