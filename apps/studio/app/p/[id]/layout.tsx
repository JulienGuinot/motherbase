'use client';

import { useEffect, type ReactNode } from 'react';
import RequireAuth from '@/shell/RequireAuth';
import Layout from '@/shell/Layout';
import ProjectGate from '@/shell/ProjectGate';
import { RequireProjectAccess } from '@/shell/ProjectUnavailable';
import { project } from '@/shared/lib/project';
import { useProjectId } from '@/shared/hooks/useRouteParam';

export default function ProjectLayout({ children }: { children: ReactNode }) {
  const id = useProjectId();

  // Keep the module-level project in step with the route: the api client reads
  // it to scope every admin and rest call.
  useEffect(() => {
    project.set(id ?? null);
  }, [id]);

  return (
    <RequireAuth>
      {/* Inside Layout, so the nav and topbar stay usable while a project is
          still coming up; outside the routed page, so no page mounts and no
          query fires until the project's API can actually answer. */}
      {/* Outside Layout: the project nav fires queries of its own, and every
          one of them would be refused for a project the caller cannot open. */}
      <RequireProjectAccess id={id}>
        <Layout>
          <ProjectGate id={id}>{children}</ProjectGate>
        </Layout>
      </RequireProjectAccess>
    </RequireAuth>
  );
}
