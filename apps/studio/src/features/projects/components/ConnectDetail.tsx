import type React from 'react';
import CopyButton from '@/shared/ui/CopyButton';

export function ConnectDetail({ icon: Icon, label, value }: { icon: React.ComponentType<{ size?: number }>; label: string; value: string }) {
  return (
    <div className="border hairline p-3" style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
      <div className="flex items-center gap-2 label">
        <Icon size={11} />
        {label}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="mono truncate text-[12px]" title={value}>{value}</span>
        <CopyButton value={value} className="btn btn-ghost shrink-0" />
      </div>
    </div>
  );
}
