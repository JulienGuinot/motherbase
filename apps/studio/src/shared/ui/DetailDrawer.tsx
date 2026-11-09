import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useDialogBehavior } from '@/shared/hooks/useDialogBehavior';

type IconType = React.ComponentType<{ size?: number; color?: string }>;

export interface DrawerTab {
  id: string;
  label: string;
  icon?: IconType;
}

// Reusable right-side slide-over (Supabase-style entity detail). Header with
// title/subtitle/avatar, optional tab bar, scrolling body, optional sticky
// footer for actions. Pages supply the per-tab content as children.
export default function DetailDrawer({
  title,
  subtitle,
  avatar,
  tabs,
  activeTab,
  onTab,
  onClose,
  footer,
  width = '30rem',
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  avatar?: ReactNode;
  tabs?: DrawerTab[];
  activeTab?: string;
  onTab?: (id: string) => void;
  onClose: () => void;
  footer?: ReactNode;
  width?: string;
  children: ReactNode;
}) {
  const panelRef = useDialogBehavior(onClose);

  return createPortal(
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="modal-scrim modal-fade flex-1" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        className="modal-rise flex w-full max-w-full flex-col overflow-hidden border-l hairline-strong sm:w-auto"
        style={{ width: `min(${width}, 100vw)`, background: 'var(--surface)', boxShadow: 'var(--shadow-pop)' }}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b hairline px-5 py-4 pt-7">
          <div className="flex min-w-0 items-center gap-3">
            {avatar}
            <div className="min-w-0">
              <div className="truncate text-[15px]" style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</div>
              {subtitle && <div className="truncate text-[11px]" style={{ color: 'var(--text-mute)' }}>{subtitle}</div>}
            </div>
          </div>
          <button onClick={onClose} className="btn btn-ghost shrink-0"><X size={14} /></button>
        </div>

        {/* Tabs */}
        {tabs && tabs.length > 0 && (
          <div className="flex gap-0 overflow-x-auto border-b px-3 hairline">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => onTab?.(id)}
                className="flex items-center gap-1.5 px-3 py-2 text-[12px]"
                style={{
                  color: activeTab === id ? 'var(--text)' : 'var(--text-mute)',
                  borderBottom: activeTab === id ? '2px solid var(--accent)' : '2px solid transparent',
                  marginBottom: -1,
                }}
              >
                {Icon && <Icon size={13} color={activeTab === id ? 'var(--accent)' : 'currentColor'} />}
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-auto px-5 py-4">{children}</div>

        {/* Footer */}
        {footer && <div className="border-t hairline p-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
