import { describe, expect, it } from 'vitest';
import {
  canAccessProject,
  canCreateProject,
  canEditSettings,
  hasPlatformCapability,
  requiredSettingsCapability,
} from '@/features/platform/hooks/usePlatformAccess';
import type { PlatformCapability, PlatformSession } from '@/shared/lib/api';

const session = (role: PlatformSession['role'], capabilities: PlatformCapability[] = []): PlatformSession => ({
  id: 'user-1',
  email: 'user@example.com',
  role,
  projects: ['demo'],
  capabilities,
});

describe('platform access', () => {
  it('reaches a project by role or by assignment, as the server scopes it', () => {
    expect(canAccessProject(session('owner'), 'other')).toBe(true);
    expect(canAccessProject(session('admin'), 'other')).toBe(true);
    expect(canAccessProject(session('developer'), 'demo')).toBe(true);
    expect(canAccessProject(session('developer'), 'other')).toBe(false);
    expect(canAccessProject(undefined, 'demo')).toBe(false);
  });

  it('uses the backend capability for project creation', () => {
    expect(canCreateProject(session('owner', ['project.create']))).toBe(true);
    expect(canCreateProject(session('admin', ['project.create']))).toBe(true);
    expect(canCreateProject(session('developer', ['project.create']))).toBe(true);
    expect(canCreateProject(session('developer'))).toBe(false);
    expect(canCreateProject(session('read_only'))).toBe(false);
  });

  it('uses backend capabilities without inferring them from the role', () => {
    expect(hasPlatformCapability(session('developer', ['runtime.manage']), 'runtime.manage')).toBe(true);
    expect(hasPlatformCapability(session('owner'), 'runtime.manage')).toBe(false);
    expect(hasPlatformCapability(undefined, 'settings.write')).toBe(false);
  });

  it('requires secrets.manage for any group containing scalar or nested secrets', () => {
    const plainFields = [{ key: 'enabled', label: 'Enabled', type: 'bool' as const }];
    const secretFields = [{ key: 'password', label: 'Password', type: 'password' as const, secret: true }];
    const nestedSecretFields = [
      { key: 'providers', label: 'Providers', type: 'json' as const, secretKeys: ['clientSecret'] },
    ];

    expect(requiredSettingsCapability(plainFields)).toBe('settings.write');
    expect(requiredSettingsCapability(secretFields)).toBe('secrets.manage');
    expect(requiredSettingsCapability(nestedSecretFields)).toBe('secrets.manage');
    expect(canEditSettings(session('developer', ['settings.write']), plainFields)).toBe(true);
    expect(canEditSettings(session('developer', ['settings.write']), secretFields)).toBe(false);
    expect(canEditSettings(session('admin', ['secrets.manage']), nestedSecretFields)).toBe(true);
    expect(canEditSettings(undefined, secretFields)).toBe(false);
  });
});
