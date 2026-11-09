'use client';

import type { ReactNode } from 'react';
import { MotherbaseProvider } from '@motherbase/ui';
import { browserClient } from '@/lib/motherbase/browser';

export function Providers({ children }: { children: ReactNode }) {
  const client = browserClient();
  if (!client) {
    return (
      <main className="setup">
        <p className="eyebrow">Setup required</p>
        <h1>Connect your Motherbase project.</h1>
        <p>Copy <code>.env.example</code> to <code>.env.local</code>, then set the URL and public key.</p>
      </main>
    );
  }
  return <MotherbaseProvider client={client}>{children}</MotherbaseProvider>;
}
