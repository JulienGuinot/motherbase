import { describe, expect, it } from 'vitest';
import { enumChanges } from '@/features/database/lib/enum-changes';

const values = ['pending', 'paid', 'shipped'];

describe('enumChanges', () => {
  it('appends a typed value after the last one', () => {
    expect(enumChanges(values, [...values, 'refunded'])).toEqual([
      { action: 'add-value', value: 'refunded', after: 'shipped' },
    ]);
  });

  it('renames a chip edited in place', () => {
    expect(enumChanges(values, ['pending', 'settled', 'shipped'])).toEqual([
      { action: 'rename-value', from: 'paid', to: 'settled' },
    ]);
  });

  it('keeps the values a chip was edited into where they were typed', () => {
    expect(enumChanges(values, ['pending', 'paid', 'refunded', 'shipped'])).toEqual([
      { action: 'add-value', value: 'refunded', after: 'paid' },
    ]);
    expect(enumChanges(values, ['draft', 'pending', 'paid', 'shipped'])).toEqual([
      { action: 'add-value', value: 'draft', before: 'pending' },
    ]);
    expect(enumChanges(values, ['pending', 'settled', 'disputed', 'shipped'])).toEqual([
      { action: 'rename-value', from: 'paid', to: 'settled' },
      { action: 'add-value', value: 'disputed', after: 'settled' },
    ]);
  });

  it('refuses a removal, including a rename that merges two values', () => {
    expect(enumChanges(values, ['pending', 'shipped'])).toBeNull();
  });

  it('has nothing to do for an unchanged list', () => {
    expect(enumChanges(values, [...values])).toEqual([]);
  });
});
