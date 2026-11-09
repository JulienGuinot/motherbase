import { describe, expect, it } from 'vitest';
import { parseThreshold } from '@/shared/lib/resourceAlerts';

describe('parseThreshold', () => {
  it('reads a stored number', () => expect(parseThreshold('70', 85)).toBe(70));
  it('falls back when absent', () => expect(parseThreshold(null, 85)).toBe(85));
  it('falls back on NaN and Infinity instead of storing them', () => {
    expect(parseThreshold('abc', 85)).toBe(85);
    expect(parseThreshold('Infinity', 85)).toBe(85);
  });
});
