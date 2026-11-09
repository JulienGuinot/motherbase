import { describe, expect, it } from 'vitest';
import { categoricalPalette, toSlices } from './palette';

const series = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `p${i}`, value: n - i }));

describe('toSlices', () => {
  it('keeps every series while there are slots, largest first', () => {
    const out = toSlices(series(8), 'light');
    expect(out).toHaveLength(8);
    expect(out.map(s => s.label)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    expect(out.map(s => s.color)).toEqual(categoricalPalette('light'));
  });

  it('never reuses a colour: the tail folds into one neutral Other', () => {
    const out = toSlices(series(12), 'dark');
    expect(out).toHaveLength(8);
    expect(new Set(out.map(s => s.color)).size).toBe(8);
    expect(out[7]).toMatchObject({ label: 'Other (5)', color: 'var(--text-mute)' });
    // 12 series of value 12..1 sum to 78; the seven named ones take 12..6.
    expect(out.reduce((sum, s) => sum + s.value, 0)).toBe(78);
  });

  it('drops empty series so they cannot claim a colour', () => {
    const out = toSlices([{ label: 'a', value: 0 }, { label: 'b', value: 3 }], 'light');
    expect(out.map(s => s.label)).toEqual(['b']);
  });
});
