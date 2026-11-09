import { CheckCircle2 } from 'lucide-react';

export function ProvisionStep({
  index,
  title,
  copy,
  active,
}: {
  index: string;
  title: string;
  copy: string;
  active: boolean;
}) {
  return (
    <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
      <div
        className="flex h-8 w-8 items-center justify-center border hairline text-[10px] tabular-nums"
        style={{
          background: active ? 'var(--accent-soft)' : 'transparent',
          color: active ? 'var(--accent)' : 'var(--text-mute)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        {active ? <CheckCircle2 size={13} /> : index}
      </div>
      <div className="min-w-0">
        <div className="text-[13px]" style={{ color: active ? 'var(--text)' : 'var(--text-dim)' }}>
          {title}
        </div>
        <div className="mt-0.5 break-all text-[11px] leading-5" style={{ color: 'var(--text-mute)' }}>
          {copy}
        </div>
      </div>
    </div>
  );
}
