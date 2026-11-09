import CopyButton from '@/shared/ui/CopyButton';
import { AuthProviderLogo } from '@/features/auth/components/AuthProviderLogo';
import { getAuthProviderMeta } from '@/features/auth/lib/auth-provider-meta';
import { StatusDot } from '@/shared/ui/Badge';
import { readinessOf, readinessTone, readinessLabel } from '@/features/auth/lib/readiness';
import type { AuthStatusItem } from '@/shared/lib/settings';

export function StatusRow({ item }: { item: AuthStatusItem }) {
  const state = readinessOf(item.enabled, item.configured);
  const isSocial = item.kind === 'social';
  const provider = isSocial ? getAuthProviderMeta(item.id) : null;
  return (
    <div className="flex items-center gap-3 border-t hairline px-5 py-2.5 first:border-t-0">
      {isSocial ? <AuthProviderLogo id={item.id} size={24} /> : <StatusDot tone={readinessTone(state)} />}
      {isSocial && <StatusDot tone={readinessTone(state)} />}
      <span className="text-[12.5px]" style={{ color: 'var(--text)' }}>{provider?.name ?? item.id}</span>
      <span className="chip" style={{ fontSize: 10, color: 'var(--text-mute)' }}>{item.kind}</span>
      <span className="text-[11.5px]" style={{ color: state === 'warn' ? 'var(--amber)' : 'var(--text-mute)' }}>
        {readinessLabel(state, item.missing)}
      </span>
      {item.callbackUrl && (
        <div className="ml-auto flex min-w-0 items-center gap-1">
          <span className="mono hidden max-w-[280px] truncate text-[11px] lg:inline" style={{ color: 'var(--text-mute)' }}>{item.callbackUrl}</span>
          <CopyButton value={item.callbackUrl} className="btn btn-ghost" />
        </div>
      )}
    </div>
  );
}
