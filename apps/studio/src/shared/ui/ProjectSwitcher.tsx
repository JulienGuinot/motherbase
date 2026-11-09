import { useEffect, useState } from 'react';
import { useProjectId } from '@/shared/hooks/useRouteParam';
import { useRouter } from 'next/navigation';
import { Boxes } from 'lucide-react';
import { platform } from '@/shared/lib/api';
import { project } from '@/shared/lib/project';
import { useOrgs } from '@/shared/lib/org';
import Select from '@/shared/ui/Select';

export default function ProjectSwitcher() {
  const [items, setItems] = useState<{ name: string }[]>([]);
  const id = useProjectId();
  const nav = useRouter();
  const { activeOrgId } = useOrgs();
  useEffect(() => {
    // Branches are picked in the branch switcher next to this one.
    platform.list(activeOrgId ?? undefined).then(data => setItems((data ?? []).filter(p => !p.branch)));
  }, [activeOrgId]);
  return (
    <Select
      value={id ?? ''}
      onChange={name => {
        project.set(name);
        nav.push(`/p/${name}/overview`);
      }}
      options={items.map(p => ({ value: p.name, label: p.name }))}
      placeholder="Select project…"
      leadingIcon={<Boxes size={13} />}
      ariaLabel="Project"
    />
  );
}
