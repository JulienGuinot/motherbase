import { describe, expect, it } from 'vitest';
import { parseCell } from '@/features/tables/lib/parse-cell';

// The in-place grid editor hands the API whatever this returns, so the two
// cases that would silently corrupt a row are the ones under test: an emptied
// cell must clear to NULL rather than write the string "", and a number that
// does not parse must not reach the column as NaN.
describe('parseCell', () => {
  it('treats an emptied cell as NULL', () => {
    expect(parseCell('', 'String')).toBeNull();
    expect(parseCell('', 'Int')).toBeNull();
  });

  it('coerces numeric columns', () => {
    expect(parseCell('42', 'Int')).toBe(42);
    expect(parseCell('1.5', 'Float')).toBe(1.5);
  });

  it('passes unparseable numbers through for the API to reject', () => {
    expect(parseCell('twelve', 'Int')).toBe('twelve');
  });

  it('reads booleans case-insensitively', () => {
    expect(parseCell('TRUE', 'Boolean')).toBe(true);
    expect(parseCell('false', 'Boolean')).toBe(false);
    expect(parseCell('nonsense', 'Boolean')).toBe(false);
  });

  it('leaves text columns alone', () => {
    expect(parseCell('  padded  ', 'String')).toBe('  padded  ');
  });
});
