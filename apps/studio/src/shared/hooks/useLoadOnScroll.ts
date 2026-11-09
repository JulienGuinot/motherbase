'use client';

import { useEffect, useRef } from 'react';

/**
 * Calls `onReach` when the returned ref's element scrolls into view, for a
 * list that fetches its next page as the reader gets to the end of it.
 *
 * `enabled` must go false while a page is in flight and once nothing is left.
 * Re-enabling it observes afresh, and a fresh observer reports an element that
 * is already visible: a page too short to push the sentinel off screen chains
 * into the next one instead of waiting for a scroll that cannot happen.
 */
export function useLoadOnScroll<T extends Element>(onReach: () => void, enabled: boolean) {
  const ref = useRef<T>(null);
  const latest = useRef(onReach);

  useEffect(() => {
    latest.current = onReach;
  });

  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) latest.current();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled]);

  return ref;
}
