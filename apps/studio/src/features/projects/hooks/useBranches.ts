'use client';

import { useQuery } from '@tanstack/react-query';
import { branchesApi, type Branch, type BranchAction } from '@/features/projects/api/hosting.api';
import { useToastMutation } from '@/features/projects/hooks/useToastMutation';

export const branchesKey = (project: string) => ['project-branches', project];

/** Creating and resetting take minutes: poll while any branch is on its way. */
const settling = (branches: Branch[] | undefined) =>
  branches?.some(b => b.status === 'creating' || b.status === 'seeding') ? 3_000 : false;

/**
 * The branch family of `project` (main first). Asked of a branch, the console
 * answers for its parent, so the switcher works from either side.
 */
export function useBranches(project: string | undefined) {
  const enabled = Boolean(project);
  const query = useQuery({
    queryKey: branchesKey(project ?? ''),
    queryFn: () => branchesApi.list(project!),
    enabled,
    refetchInterval: q => settling(q.state.data),
  });
  const key = branchesKey(project ?? '');

  const create = useToastMutation(key, (body: { name: string; gitBranch?: string; withData: boolean }) =>
    branchesApi.create(project!, body), {
    success: b => `Creating ${b.name}. It takes a few minutes.`,
    failure: 'Branch not created',
  });
  const remove = useToastMutation(key, (branch: string) => branchesApi.remove(project!, branch), {
    success: 'Branch deleted',
    failure: 'Delete failed',
  });
  const act = useToastMutation(key, ({ branch, action }: { branch: string; action: BranchAction }) =>
    branchesApi.action(project!, branch, action), {
    success: data => (data.applied ? `${data.applied.length} migration(s) applied` : `${data.name} updated`),
    failure: 'Branch action failed',
  });

  return { enabled, query, branches: query.data ?? [], create, remove, act };
}

export function useBranchDetail(project: string | undefined, branch: string | null) {
  return useQuery({
    queryKey: [...branchesKey(project ?? ''), 'detail', branch],
    queryFn: () => branchesApi.get(project!, branch!),
    enabled: Boolean(project && branch),
  });
}
