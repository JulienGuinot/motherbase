import { describe, expect, it } from 'vitest';
import { columnTypeGroups, enumTypeRef } from '@/features/tables/lib/column-types';

describe('column type picker', () => {
  it('qualifies enums outside public only', () => {
    expect(enumTypeRef('public', 'mood')).toBe('mood');
    expect(enumTypeRef('reporting', 'mood')).toBe('reporting.mood');
  });

  it('adds an enum group only when the schema has enums', () => {
    expect(columnTypeGroups('public', [])).toHaveLength(1);
    const groups = columnTypeGroups('reporting', ['status']);
    expect(groups[1]).toEqual({ label: 'Enumerated types', options: [{ value: 'reporting.status', label: 'reporting.status' }] });
  });
});
