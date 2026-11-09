import { describe, expect, it } from 'vitest';
import { parseInt8 } from '../lib/pg-int8';

describe('parseInt8', () => {
  it('returns a number for values a JS number holds exactly', () => {
    expect(parseInt8('45')).toBe(45);
    expect(parseInt8('-9007199254740991')).toBe(-9007199254740991);
    expect(parseInt8(null)).toBeNull();
  });

  it('keeps the string past the safe range rather than losing precision', () => {
    expect(parseInt8('9007199254740993')).toBe('9007199254740993');
    expect(parseInt8('9223372036854775807')).toBe('9223372036854775807');
  });
});
