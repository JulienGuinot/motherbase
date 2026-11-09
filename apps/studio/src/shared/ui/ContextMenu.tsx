import { useEffect } from 'react';
import ReactDOM from 'react-dom';

export interface MenuItem {
  type?: 'item' | 'separator';
  label?: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  action?: () => void;
}

interface ContextMenuProps {
  items: MenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}

export function ContextMenu({ items, x, y, onClose }: ContextMenuProps) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const handleClick = () => onClose();
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  // Flip away from the edge the menu would cross, then clamp: on a 390px
  // screen flipping alone puts the menu at a negative x whenever the tap was
  // within 200px of the left edge, which is most of the screen.
  const menuW = 200;
  const menuH = items.reduce((h, i) => h + (i.type === 'separator' ? 9 : 34), 8);
  const viewportW = typeof window === 'undefined' ? menuW : window.innerWidth;
  const viewportH = typeof window === 'undefined' ? menuH : window.innerHeight;
  const clamp = (value: number, max: number) => Math.max(4, Math.min(value, max - 4));
  const left = clamp(x + menuW > viewportW ? x - menuW : x, viewportW - menuW);
  const top = clamp(y + menuH > viewportH ? y - menuH : y, viewportH - menuH);

  return ReactDOM.createPortal(
    <div
      onMouseDown={e => e.stopPropagation()}
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 9999,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-pop)',
        minWidth: 200,
        padding: '4px 0',
      }}
    >
      {items.map((item, i) => {
        if (item.type === 'separator') {
          return (
            <div
              key={i}
              style={{ height: 1, background: 'var(--border)', margin: '4px 0' }}
            />
          );
        }
        return (
          <button
            key={i}
            disabled={item.disabled}
            onClick={() => { try { item.action?.(); } finally { onClose(); } }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--hover)] disabled:opacity-40"
            style={{
              color: item.danger ? 'var(--red)' : 'var(--text)',
              background: 'transparent',
              border: 'none',
              cursor: item.disabled ? 'default' : 'pointer',
            }}
          >
            {item.icon && <span style={{ opacity: 0.65, display: 'flex', alignItems: 'center' }}>{item.icon}</span>}
            {item.label}
          </button>
        );
      })}
    </div>,
    document.body
  );
}
