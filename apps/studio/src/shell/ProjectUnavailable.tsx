'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Mascot } from '@/shared/ui/Mascot';
import { RouteLoading } from '@/shared/ui/RouteLoading';
import { canAccessProject, usePlatformMe } from '@/features/platform/hooks/usePlatformAccess';

const Id = ({ id }: { id: string }) => <span className="mono" style={{ color: 'var(--text)' }}>{id}</span>;

const COPY = {
  forbidden: {
    mascot: 'shield-keylock',
    title: 'You do not have access to this project',
    body: (id: string) => <>Your account is not assigned to <Id id={id} />. Ask an owner or admin of this console to add you.</>,
  },
  missing: {
    mascot: 'looking-map',
    title: 'This project does not exist',
    body: (id: string) => <>There is no project called <Id id={id} />. It may have been deleted, or the link is mistyped.</>,
  },
} as const;

/** Full-page refusal for a project URL the caller cannot open. */
export function ProjectUnavailable({ id, reason }: { id: string; reason: keyof typeof COPY }) {
  const copy = COPY[reason];
  return (
    <div className="flex min-h-[70vh] flex-1 flex-col items-center justify-center gap-5 p-10 text-center">
      <Mascot name={copy.mascot} size={132} float />
      <div className="max-w-md space-y-2">
        <h1 className="display-heading text-[20px]" style={{ color: 'var(--text)' }}>{copy.title}</h1>
        <p className="text-[13px] leading-6" style={{ color: 'var(--text-dim)' }}>{copy.body(id)}</p>
      </div>
      <Link href="/" className="btn btn-primary">All projects</Link>
    </div>
  );
}

/**
 * Refuses a project the session is not scoped to before anything of the
 * project mounts. Typing another project's id into the URL used to open its
 * shell, and every query on the page answered 403 with a toast of its own.
 */
export function RequireProjectAccess({ id, children }: { id: string | undefined; children: ReactNode }) {
  const me = usePlatformMe();
  if (!id) return <>{children}</>;
  if (me.isPending) return <RouteLoading />;
  // Without the session the server still refuses; ProjectGate shows its answer.
  if (me.data && !canAccessProject(me.data, id)) return <ProjectUnavailable id={id} reason="forbidden" />;
  return <>{children}</>;
}
