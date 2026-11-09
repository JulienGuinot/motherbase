import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { useDialogBehavior } from '@/shared/hooks/useDialogBehavior';

interface ModalProps {
  onClose: () => void;
  children: ReactNode;
  /** CSS value for the max desired width, e.g. "560px" or "900px". Capped at 92vw. */
  width?: string;
  /** Force the modal to fill the available viewport height (useful for previews). */
  fullHeight?: boolean;
  /** Optional class names appended to the card. */
  className?: string;
  /** Accessible name when the modal has no <ModalHeader> to label it. */
  ariaLabel?: string;
}

/**
 * Console modal shell: matches the webhook / new-table modal aesthetic:
 *   - blurred ink backdrop
 *   - elevated centered card capped at the viewport height
 *   - click-outside + Escape to close
 *
 * Compose the contents with <ModalHeader>, <ModalBody>, <ModalFooter> so the
 * body scrolls internally while the title and actions stay pinned.
 */
export function Modal({ onClose, children, width = '560px', fullHeight = false, className = '', ariaLabel }: ModalProps) {
  const cardRef = useDialogBehavior(onClose);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div className="modal-scrim modal-fade fixed inset-0" />
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        onClick={event => event.stopPropagation()}
        className={`relative modal-rise flex max-w-full flex-col ${className}`}
        style={{
          width: `min(${width}, 100vw)`,
          maxHeight: 'calc(100dvh - env(safe-area-inset-top))',
          height: fullHeight ? 'calc(100dvh - env(safe-area-inset-top))' : undefined,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-pop)',
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

interface ModalHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
}

/** Pinned modal header. */
export function ModalHeader({ eyebrow, title, description }: ModalHeaderProps) {
  return (
    <header className="shrink-0 border-b px-4 pb-4 pt-5 hairline sm:px-6 sm:pb-5 sm:pt-6">
      {eyebrow && <span className="label">{eyebrow}</span>}
      {/* Sized down from 28/33px: at that scale a modal title outweighed the
          page heading behind it and pushed the actual form below the fold. */}
      <h1
        className={`${eyebrow ? 'mt-2' : ''} text-[17px] leading-tight sm:text-[18px]`}
        style={{ color: 'var(--text)', fontWeight: 600, letterSpacing: '-0.01em' }}
      >
        {title}
      </h1>
      {description && (
        <p className="mt-2 max-w-[460px] text-[12px]" style={{ color: 'var(--text-mute)' }}>
          {description}
        </p>
      )}
    </header>
  );
}

interface ModalBodyProps {
  children: ReactNode;
  className?: string;
}

/** Scrollable middle area. The header and footer stay pinned. */
export function ModalBody({ children, className = '' }: ModalBodyProps) {
  return <div className={`flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5 ${className}`}>{children}</div>;
}

interface ModalFooterProps {
  children: ReactNode;
  className?: string;
}

/** Pinned right-aligned action row. */
export function ModalFooter({ children, className = '' }: ModalFooterProps) {
  return (
    <footer
      className={`flex shrink-0 flex-wrap justify-end gap-2 border-t px-4 py-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] hairline sm:px-6 sm:py-4 ${className}`}
    >
      {children}
    </footer>
  );
}
