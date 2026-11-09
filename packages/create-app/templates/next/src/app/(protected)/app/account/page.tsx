'use client';

import Link from 'next/link';
import { SecurityPanel, UserProfileForm } from '@motherbase/ui';
import { authOptions } from '@/config/auth';
import { WorkspaceShell } from '@/components/workspace-shell';

function SecuritySettings() {
  if (authOptions.passkeys || authOptions.mfa) {
    return <SecurityPanel passkeys={authOptions.passkeys} mfa={authOptions.mfa} />;
  }
  return (
    <div className="starter-card">
      <span>SECURITY</span>
      <strong>More ways to sign in</strong>
      <p>Enable passkeys or MFA in Motherbase, then turn them on in <code>src/config/auth.ts</code>.</p>
    </div>
  );
}

export default function Account() {
  return (
    <WorkspaceShell>
        <Link className="app-link" href="/app">← Workspace</Link>
        <span className="eyebrow">ACCOUNT</span>
        <h1>Your account.</h1>
        <div className="settings-grid"><UserProfileForm /><SecuritySettings /></div>
    </WorkspaceShell>
  );
}
