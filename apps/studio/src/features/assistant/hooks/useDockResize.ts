import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { clampWidth, type DockState } from '@/features/assistant/lib/dock-state';

const RESIZE_STEP = 24;
const KEY_STEPS: Record<string, number> = { ArrowLeft: RESIZE_STEP, ArrowRight: -RESIZE_STEP };

function tryPointerCapture(target: HTMLElement, pointerId: number, capture: boolean): void {
  const method = capture ? target.setPointerCapture : target.releasePointerCapture;
  if (typeof method !== 'function') return;
  try {
    method.call(target, pointerId);
  } catch {
    /* unsupported (e.g. jsdom) or already released: the window listeners do not depend on capture. */
  }
}

/** Drag and arrow-key handlers for the dock's left edge. */
export function useDockResize(setDock: Dispatch<SetStateAction<DockState>>) {
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // Drag cleanup only runs a naked function once armed by a pointer down; if
  // the dock unmounts mid-drag (e.g. the operator navigates away), the window
  // listeners it registered must still be torn down.
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const target = e.currentTarget;
    tryPointerCapture(target, e.pointerId, true);

    const onMove = (ev: PointerEvent) => {
      setDock(d => ({ ...d, width: clampWidth(window.innerWidth - ev.clientX) }));
    };
    const detach = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    const onUp = (ev: PointerEvent) => {
      detach();
      dragCleanupRef.current = null;
      tryPointerCapture(target, ev.pointerId, false);
    };

    dragCleanupRef.current = detach;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [setDock]);

  const handleResizeKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = KEY_STEPS[e.key];
    if (!step) return;
    e.preventDefault();
    setDock(d => ({ ...d, width: clampWidth(d.width + step) }));
  }, [setDock]);

  return { startResize, handleResizeKeyDown };
}
