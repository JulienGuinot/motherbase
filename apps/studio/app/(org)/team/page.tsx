'use client';

import { RequirePlatformCapability } from '@/shell/RequireAuth';
import Team from '@/features/platform/pages/Team';

export default function TeamPage() {
  return (
    <RequirePlatformCapability capability="users.manage">
      <Team />
    </RequirePlatformCapability>
  );
}
