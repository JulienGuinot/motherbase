import type React from 'react';

export function PaneTab({ active, onClick, icon: Icon, label, count }: { active: boolean; onClick: () => void; icon: React.ComponentType<{ size?: number }>; label: string; count?: number }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-1 items-center justify-center gap-2 py-2.5 text-[11px]"
      style={{
        color: active ? 'var(--paper)' : 'var(--paper-mute)',
        borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
        background: active ? 'var(--ink-2)' : 'transparent',
      }}
    >
      <Icon size={12} />
      <span>{label}</span>
      {count != null && <span className="tabular-nums opacity-60">{count}</span>}
    </button>
  );
}
