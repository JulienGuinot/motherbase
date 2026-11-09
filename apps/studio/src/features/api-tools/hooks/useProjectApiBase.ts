'use client';

import { useQuery } from '@tanstack/react-query';
import { platform } from '@/shared/lib/api';
import { project } from '@/shared/lib/project';

/** The current project's own public API origin, which is not the console's. */
export function useProjectApiBase(): string {
  const projectsQuery = useQuery({
    queryKey: ['platform-projects'],
    queryFn: () => platform.list(),
    staleTime: 30_000,
    retry: false,
  });
  const current = (projectsQuery.data ?? []).find(p => p.name === project.get());
  return String(
    current?.apiUrl ??
      (current?.domain ? `${window.location.protocol}//${current.domain}` : window.location.origin)
  ).replace(/\/$/, '');
}
