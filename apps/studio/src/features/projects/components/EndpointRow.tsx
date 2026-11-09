import type { ComponentType, CSSProperties } from 'react';
import { Circle } from 'lucide-react';

export interface EndpointPreview {
  icon: ComponentType<{ size?: number; style?: CSSProperties; className?: string }>;
  label: string;
  value: string;
  pending: string;
  accent: string;
}

export function EndpointRow({ icon: Icon, label, value, pending, accent }: EndpointPreview) {
  const ready = Boolean(value);

  return (
    <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 border-t hairline px-5 py-4 first:border-t-0">
      <div
        className="flex h-8 w-8 items-center justify-center border hairline"
        style={{ background: ready ? 'var(--surface-2)' : 'transparent', color: ready ? accent : 'var(--text-mute)', borderRadius: 'var(--radius-sm)' }}
      >
        <Icon size={14} />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>{label}</span>
          <Circle size={6} fill={ready ? accent : 'var(--text-mute)'} stroke="none" />
        </div>
        <div
          className="mt-1 break-all mono text-[11px] leading-5"
          style={{ color: ready ? 'var(--text)' : 'var(--text-mute)' }}
        >
          {ready ? value : pending}
        </div>
      </div>
    </div>
  );
}
