import { AuthProviderBadge } from '@/features/auth/components/AuthProviderLogo';

export function SummaryLine({ label, values, empty, providerBadges = false }: { label: string; values: string[]; empty: string; providerBadges?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-16 shrink-0 pt-0.5 text-[11.5px]" style={{ color: 'var(--text-mute)' }}>{label}</span>
      {values.length ? (
        <div className="flex flex-wrap gap-1.5">
          {values.map(v => providerBadges ? <AuthProviderBadge key={v} id={v} /> : <span key={v} className="chip" style={{ color: 'var(--text-dim)' }}>{v}</span>)}
        </div>
      ) : (
        <span className="text-[12px]" style={{ color: 'var(--text-mute)' }}>{empty}</span>
      )}
    </div>
  );
}
