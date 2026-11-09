'use client';

import Link from 'next/link';
import { useUser } from '@motherbase/ui';
import { WorkspaceShell } from '@/components/workspace-shell';

export default function Dashboard() {
  const user = useUser();
  return (
    <WorkspaceShell>
        <span className="eyebrow">YOUR WORKSPACE</span>
        <h1>Welcome{user?.name ? `, ${user.name}` : ''}.</h1>
        <p>Authentication is ready. Replace this space with the product you want to build.</p>
        <div className="starter-grid">
          <Link href="/app/account" className="starter-card">
            <span>01 / ACCOUNT</span>
            <strong>Profile & security</strong>
            <p>Edit your profile, add passkeys and manage MFA.</p>
            <b>Open settings →</b>
          </Link>
          <div className="starter-card">
            <span>02 / NEXT STEP</span>
            <strong>Make it yours</strong>
            <p>Use the Motherbase client to add data, storage, functions and realtime features.</p>
          </div>
        </div>
    </WorkspaceShell>
  );
}
