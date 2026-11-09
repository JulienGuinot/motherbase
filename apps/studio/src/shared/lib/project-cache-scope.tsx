'use client';

import { useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useProjectId } from '@/shared/hooks/useRouteParam';
import { project } from '@/shared/lib/project';

/**
 * The query cache belongs to one project at a time.
 *
 * `QueryProvider` builds a single QueryClient for the whole app and the keys
 * name the table, the schema, the filters: never the project. So switching from
 * project A to project B left A's tables, rows, users, files, settings and jobs
 * in the cache under keys B reads from, and within the 10s freshness window B's
 * screens rendered A's data under B's name. Any command issued from that view
 * then targeted B while the operator was looking at A.
 *
 * Every key would have to carry the project for the alternative to hold, and one
 * key that forgot would bring the whole class of bug back. Dropping the cache at
 * the boundary is the version that cannot be forgotten.
 *
 * `project.set` is refreshed here too: `project.get()` prefers the module
 * variable over the pathname, so a project reached by a link rather than by the
 * switcher (which is the only caller that used to set it) would keep prefixing
 * its requests with the project the operator came from.
 */
export function ProjectCacheScope({ children }: { children: ReactNode }) {
  const projectId = useProjectId() ?? null;
  const client = useQueryClient();
  // `undefined` is "first render", which must not clear: there is nothing stale
  // yet, and clearing here would throw away a cache the shell just warmed.
  const previous = useRef<string | null | undefined>(undefined);

  if (previous.current !== projectId) {
    if (previous.current !== undefined) {
      // Deliberately during render, not in an effect: an effect runs after the
      // children have already rendered, which is exactly one paint of the old
      // project's data under the new project's name.
      void client.cancelQueries();
      client.clear();
    }
    project.set(projectId);
    previous.current = projectId;
  }

  return <>{children}</>;
}
