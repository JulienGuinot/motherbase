'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/shared/lib/auth';
import { hasPlatformCapability, usePlatformMe } from '@/features/platform/hooks/usePlatformAccess';
import type { PlatformCapability } from '@/shared/lib/api';
import { RouteLoading } from '@/shared/ui/RouteLoading';
import { usePlatformFeatureState, type PlatformFeatures } from '@/features/platform/hooks/usePlatformFeatures';

/**
 * Send the browser elsewhere and render nothing meanwhile. Replaces
 * react-router's <Navigate>: next has no declarative redirect for a client
 * component, and calling router.replace during render is not allowed.
 */
function Redirect({ to }: { to: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(to);
  }, [router, to]);
  return null;
}

export default function RequireAuth({ children }: { children: ReactNode }) {
  if (!auth.isAuthed()) return <Redirect to="/login" />;
  if (auth.mustChangePassword()) return <Redirect to="/password-change-required" />;
  return <>{children}</>;
}

export function RequirePasswordChange({ children }: { children: ReactNode }) {
  if (!auth.isAuthed()) return <Redirect to="/login" />;
  if (!auth.mustChangePassword()) return <Redirect to="/" />;
  return <>{children}</>;
}

export function RequirePlatformCapability({
  capability,
  children,
}: {
  capability: PlatformCapability;
  children: ReactNode;
}) {
  const meQuery = usePlatformMe();
  if (meQuery.isPending) return <RouteLoading />;
  if (!hasPlatformCapability(meQuery.data, capability)) return <Redirect to="/" />;
  return <>{children}</>;
}

/**
 * Route guard for an optional console surface. Hiding the nav entry is not
 * enough on its own: the URL stays typeable, and the page would then call
 * endpoints this console does not serve.
 */
export function RequirePlatformFeature({
  feature,
  children,
}: {
  feature: keyof PlatformFeatures;
  children: ReactNode;
}) {
  const { features, pending } = usePlatformFeatureState();
  if (pending) return <RouteLoading />;
  return features[feature] ? <>{children}</> : <Redirect to="/" />;
}
