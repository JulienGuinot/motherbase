'use client';

import { useRouter, usePathname } from 'next/navigation';
import { GitBranch } from 'lucide-react';
import Select from '@/shared/ui/Select';
import { useProjectId } from '@/shared/hooks/useRouteParam';
import { project as currentProject } from '@/shared/lib/project';
import { useBranches } from '@/features/projects/hooks/useBranches';

/**
 * Topbar switcher between a project and its preview branches. Keeps the page:
 * switching from main's Table Editor lands on the branch's Table Editor.
 * Renders nothing until the project has a branch, so it costs nothing to
 * projects that never use them.
 */
export default function BranchSwitcher() {
  const id = useProjectId();
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const { branches } = useBranches(id);
  if (!id || branches.length < 2) return null;

  const rest = pathname.replace(/^\/p\/[^/]+/, '') || '/overview';
  return (
    <Select
      value={id}
      onChange={next => {
        currentProject.set(next);
        router.push(`/p/${encodeURIComponent(next)}${rest}`);
      }}
      options={branches.map(b => ({
        value: b.project,
        label: b.isDefault ? `${b.name} (production)` : b.status === 'active' ? b.name : `${b.name} · ${b.status}`,
        disabled: !b.isDefault && b.status !== 'active',
      }))}
      leadingIcon={<GitBranch size={13} />}
      ariaLabel="Branch"
    />
  );
}
