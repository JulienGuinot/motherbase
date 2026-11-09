'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { UserButton } from '@motherbase/ui';

export function WorkspaceShell({ children }: { children: ReactNode }) {
  return (
    <main className="workspace">
      <header className="workspace-header">
        <Link className="brand" href="/app">MOTHERBASE <span>STARTER</span></Link>
        <UserButton
          profileHref="/app/account"
          securityHref="/app/account"
          onSignOut={() => { window.location.assign('/login'); }}
        />
      </header>
      <section className="workspace-content">{children}</section>
    </main>
  );
}
