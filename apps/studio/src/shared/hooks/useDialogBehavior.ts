import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * The keyboard contract every overlay in the studio owes its user: Escape
 * closes it, Tab stays inside it, focus starts inside it, and focus goes back
 * to whatever opened it on the way out. Page scrolling is frozen underneath so
 * the wheel does not move the page behind the panel.
 *
 * Nested overlays (a create-enum modal over Compose a table) share this hook.
 * Only the top of the stack handles Escape and Tab, otherwise both would close
 * on the first Escape.
 *
 * Returns the ref to attach to the panel element (not the backdrop).
 */
const dialogStack: Array<{ onClose: () => void }> = [];

export function useDialogBehavior(onClose: () => void) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Callers pass an inline onClose, new on every render. Keeping it out of the
  // effect deps stops each keystroke from re-running the setup, which would
  // refocus the first field and steal focus from the one being typed in.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const entry = { onClose: () => onCloseRef.current() };
    dialogStack.push(entry);
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    function isTop() {
      return dialogStack[dialogStack.length - 1] === entry;
    }

    function onKey(event: KeyboardEvent) {
      if (!isTop()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const targets = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null);
      if (targets.length === 0) return;
      const edge = event.shiftKey ? targets[0] : targets[targets.length - 1];
      if (document.activeElement === edge || !panel.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? targets[targets.length - 1] : targets[0]).focus();
      }
    }

    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      const index = dialogStack.lastIndexOf(entry);
      if (index >= 0) dialogStack.splice(index, 1);
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      opener?.focus?.();
    };
  }, []);

  return panelRef;
}
