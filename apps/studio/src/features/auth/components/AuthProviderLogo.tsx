import type { ReactNode } from 'react';
import { BrandLogo } from '@/shared/ui/BrandLogo';

import { getAuthProviderMeta } from '@/features/auth/lib/auth-provider-meta';

interface AuthProviderLogoProps {
  id: string;
  size?: number;
  className?: string;
  title?: string;
}

export function AuthProviderLogo({ id, size = 28, className = '', title }: AuthProviderLogoProps) {
  const meta = getAuthProviderMeta(id);
  return <BrandLogo brand={meta.logo} label={title ?? meta.name} size={size} className={className} />;
}

export function AuthProviderBadge({ id }: { id: string }) {
  const meta = getAuthProviderMeta(id);
  return (
    <span className="chip inline-flex items-center gap-1.5" style={{ color: 'var(--text-dim)' }}>
      <AuthProviderLogo id={id} size={16} />
      {meta.name}
    </span>
  );
}

// `ids` is optional because a user row that predates the providers projection
// (or any caller that forgets `?? []`) would otherwise crash the whole table on
// `.length`. An absent list and an empty one mean the same thing here.
export function AuthProviderBadges({ ids, empty = '-' }: { ids?: string[] | null; empty?: ReactNode }) {
  if (!ids?.length) return <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>{empty}</span>;
  return <>{ids.map(id => <AuthProviderBadge key={id} id={id} />)}</>;
}
