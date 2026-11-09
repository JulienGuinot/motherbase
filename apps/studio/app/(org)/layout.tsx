'use client';

import type { ReactNode } from 'react';
import RequireAuth from '@/shell/RequireAuth';
import OrgLayout from '@/shell/OrgLayout';

export default function OrgGroupLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <OrgLayout>{children}</OrgLayout>
    </RequireAuth>
  );
}
