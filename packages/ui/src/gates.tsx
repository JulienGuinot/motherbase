'use client';

import type { ReactNode } from 'react';
import { useAuth } from './context.js';
import { classes, Notice, useFormAction } from './shared.js';

/** Renders `children` for a signed-in user. UI only: authorize on the server. */
export function SignedIn({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const { user, loading } = useAuth();
  return <>{loading ? null : user ? children : fallback}</>;
}

export function SignedOut({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  return <>{loading || user ? null : children}</>;
}

/** Renders `children` only while the session is being restored: skeletons, spinners. */
export function AuthLoading({ children }: { children: ReactNode }) {
  return <>{useAuth().loading ? children : null}</>;
}

export function SignOutButton({ onSignOut, className, children = 'Sign out' }: {
  onSignOut?: () => void;
  className?: string;
  children?: ReactNode;
}) {
  const { signOut } = useAuth();
  const { busy, error, run } = useFormAction();

  return <><button type="button" disabled={busy} className={classes('mbui-button mbui-button-secondary', className)} onClick={() => void run(async () => {
    await signOut();
    onSignOut?.();
    return { error: null };
  })}>{children}</button><Notice error>{error}</Notice></>;
}
