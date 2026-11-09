'use client';

import { createPortal } from 'react-dom';
import { useCallback, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { useDialogBehavior } from '@/shared/hooks/useDialogBehavior';

const GAP = 4;
const MARGIN = 8;
/** Below this much room under the anchor, open upwards if there is more room above. */
const MIN_ROOM = 200;

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Placement {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * Where a dropdown goes, kept inside the viewport.
 *
 * Anchored with CSS alone (`absolute right-0 w-[210px]`), a panel opened from a
 * button near the left of a phone screen hung off the left edge, and one opened
 * low on the page ran under the bottom of the screen. Clamped here instead.
 */
export function popoverPlacement(
  anchor: Box,
  viewport: { width: number; height: number },
  width: number,
  align: 'start' | 'end'
): Placement {
  const fitted = Math.min(width, viewport.width - 2 * MARGIN);
  const preferred = align === 'end' ? anchor.right - fitted : anchor.left;
  const left = Math.max(MARGIN, Math.min(preferred, viewport.width - fitted - MARGIN));

  const below = viewport.height - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  if (below < MIN_ROOM && above > below) {
    return { left, width: fitted, bottom: viewport.height - anchor.top + GAP, maxHeight: above };
  }
  return { left, width: fitted, top: anchor.bottom + GAP, maxHeight: below };
}

/**
 * A dropdown panel under (or above) the element that opened it. Portalled and
 * fixed, so neither a clipping card nor a transformed ancestor can cut it off,
 * with the same Escape / focus / scroll-lock contract as every other overlay.
 */
export function Popover({
  anchor,
  onClose,
  width,
  align = 'start',
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Desired width in px. Narrowed to fit the viewport on small screens. */
  width: number;
  /** Which edge of the anchor the panel lines up with. */
  align?: 'start' | 'end';
  children: ReactNode;
}) {
  // The dialog hook re-runs (and re-focuses the first item) whenever its
  // callback changes, and callers pass a fresh arrow on every render: on the
  // live log stream that is every two seconds. Hand it a stable one.
  const latestClose = useRef(onClose);
  useLayoutEffect(() => {
    latestClose.current = onClose;
  });
  const close = useCallback(() => latestClose.current(), []);
  const panelRef = useDialogBehavior(close);
  const rect = anchor.current?.getBoundingClientRect();
  if (!rect) return null;

  const placement = popoverPlacement(rect, { width: window.innerWidth, height: window.innerHeight }, width, align);

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={close} />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="fixed z-50 overflow-auto rounded-md border py-1 shadow-lg"
        style={{ ...placement, background: 'var(--surface)', borderColor: 'var(--border)' }}
      >
        {children}
      </div>
    </>,
    document.body
  );
}
