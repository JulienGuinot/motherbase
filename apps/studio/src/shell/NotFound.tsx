'use client';

import { usePathname } from 'next/navigation';
import { useProjectId } from '@/shared/hooks/useRouteParam';
import Link from 'next/link';
import { Mascot } from '@/shared/ui/Mascot';

// Shown for any route that doesn't match: both unknown project sub-pages
// (rendered inside a project layout) and unknown top-level paths.
export default function NotFound() {
  const id = useProjectId();
  const pathname = usePathname();
  const backTo = id ? `/p/${id}/overview` : '/';
  const backLabel = id ? 'Back to project' : 'All projects';

  return (
    <div className="flex min-h-[60vh] flex-1 flex-col items-center justify-center gap-5 p-10 text-center">
      <Mascot name="looking-map" size={132} float />
      <div className="max-w-md space-y-2">
        <h1 className="display-heading text-[20px]" style={{ color: 'var(--text)' }}>Page not found</h1>
        <p className="text-[13px] leading-6" style={{ color: 'var(--text-dim)' }}>
          We couldn't find <span className="mono" style={{ color: 'var(--text)' }}>{pathname}</span>. The link may be
          outdated or the page may have moved.
        </p>
      </div>
      <Link href={backTo} className="btn btn-primary">{backLabel}</Link>
    </div>
  );
}
