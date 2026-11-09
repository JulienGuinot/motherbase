import type { ReactNode } from 'react';
import Link from 'next/link';

export function AuthPage({ children }: { children: ReactNode }) {
  return (
    <main className="auth-page">
      <Link className="brand" href="/">MOTHERBASE <span>STARTER</span></Link>
      {children}
    </main>
  );
}
