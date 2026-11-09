import { useEffect, useState } from 'react';
import { useIsFetching } from '@tanstack/react-query';

/**
 * Hairline progress bar pinned under the topbar while queries are in flight.
 *
 * Lists now keep their previous rows on screen while a new page or filter
 * loads, which is the right behaviour but leaves nothing on screen saying the
 * app is working. This is that signal, in one place rather than per page.
 *
 * It waits before showing: several panels poll on a timer, and a bar that
 * blinks every few seconds reads as a glitch rather than as progress. Anything
 * that resolves quickly never draws at all.
 */
const SHOW_AFTER_MS = 400;

export function FetchProgress() {
  const fetching = useIsFetching();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!fetching) return;
    const timer = window.setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    // Hiding happens in cleanup rather than in the effect body: cleanup already
    // runs the moment `fetching` drops back to zero, and a synchronous setState
    // in the body would cascade a render on every fetch transition.
    return () => {
      window.clearTimeout(timer);
      setVisible(false);
    };
  }, [fetching]);

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden"
      style={{ opacity: visible ? 1 : 0, transition: 'opacity .2s' }}
    >
      <div className="indeterminate h-full" style={{ background: 'var(--accent)' }} />
    </div>
  );
}
