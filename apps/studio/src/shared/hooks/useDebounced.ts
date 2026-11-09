'use client';

import { useEffect, useState } from 'react';

/**
 * Trails `value` by `delayMs`, so a value that is still being typed can drive an
 * expensive consumer without firing on every keystroke.
 *
 * Keep the immediate value on the input and the debounced one on whatever costs
 * something: a query key, a request, a heavy recompute. The field stays as
 * responsive as any other controlled input; only the work behind it waits.
 */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
