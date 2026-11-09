import { useQuery } from '@tanstack/react-query';
import { platform, type PlatformCapability, type PlatformSession } from '@/shared/lib/api';
import type { FieldDef } from '@/shared/lib/settings';

export function hasPlatformCapability(
  session: PlatformSession | null | undefined,
  capability: PlatformCapability
): boolean {
  return session?.capabilities.includes(capability) ?? false;
}

/** Mirrors the server's `hasProjectScope`: owners and admins reach every project. */
export function canAccessProject(session: PlatformSession | null | undefined, projectId: string): boolean {
  if (!session) return false;
  return session.role === 'owner' || session.role === 'admin' || session.projects.includes(projectId);
}

export function canCreateProject(session: PlatformSession | null | undefined): boolean {
  return hasPlatformCapability(session, 'project.create');
}

export function requiredSettingsCapability(fields: FieldDef[]): PlatformCapability {
  const containsSecrets = fields.some(field => field.secret || Boolean(field.secretKeys?.length));
  return containsSecrets ? 'secrets.manage' : 'settings.write';
}

export function canEditSettings(session: PlatformSession | null | undefined, fields: FieldDef[]): boolean {
  return hasPlatformCapability(session, requiredSettingsCapability(fields));
}

export function usePlatformMe(enabled = true) {
  return useQuery({ queryKey: ['platform-me'], queryFn: platform.me, staleTime: 60_000, enabled });
}

export function useProjectCapability(capability: PlatformCapability) {
  const platformMeQuery = usePlatformMe();

  return {
    editable: hasPlatformCapability(platformMeQuery.data, capability),
    pending: platformMeQuery.isPending,
  };
}
