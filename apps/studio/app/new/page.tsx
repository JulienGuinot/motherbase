'use client';

import RequireAuth, { RequirePlatformCapability } from '@/shell/RequireAuth';
import CreateProject from '@/features/projects/pages/CreateProject';

export default function NewProjectPage() {
  return (
    <RequireAuth>
      <RequirePlatformCapability capability="project.create">
        <CreateProject />
      </RequirePlatformCapability>
    </RequireAuth>
  );
}
