import { describe, expect, it, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePersistentState } from '@/shared/hooks/usePersistentState';

beforeEach(() => localStorage.clear());

describe('usePersistentState', () => {
  it('re-reads when the key changes instead of carrying the old value over', () => {
    localStorage.setItem('b', JSON.stringify('from-b'));

    const { result, rerender } = renderHook(({ key }) => usePersistentState<string>(key, 'initial'), {
      initialProps: { key: 'a' },
    });

    act(() => result.current[1]('written-to-a'));
    expect(localStorage.getItem('a')).toBe(JSON.stringify('written-to-a'));

    rerender({ key: 'b' });
    expect(result.current[0]).toBe('from-b');
    expect(localStorage.getItem('a')).toBe(JSON.stringify('written-to-a'));
  });
});
