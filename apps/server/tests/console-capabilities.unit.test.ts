import { describe, expect, it, vi } from 'vitest';
import { capabilitiesForRole, hasProjectScope, requireProjectCapability } from '../console/auth/capabilities';

describe('console capabilities', () => {
  it('keeps member as a legacy developer alias', () => {
    expect(capabilitiesForRole('member')).toEqual(capabilitiesForRole('developer'));
    expect(capabilitiesForRole('developer')).toEqual(['project.read', 'content.write']);
    expect(capabilitiesForRole('read_only')).toEqual(['project.read']);
    expect(capabilitiesForRole('admin')).toContain('project.create');
    expect(capabilitiesForRole('admin')).toContain('project.delete');
  });

  it('keeps owner/admin global and scopes other roles to projects', () => {
    expect(hasProjectScope('owner', [], 'alpha')).toBe(true);
    expect(hasProjectScope('admin', [], 'alpha')).toBe(true);
    expect(hasProjectScope('developer', ['alpha'], 'alpha')).toBe(true);
    expect(hasProjectScope('developer', ['alpha'], 'beta')).toBe(false);
  });

  it('requires both the capability and project assignment', () => {
    const middleware = requireProjectCapability('content.write');
    const next = vi.fn();
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    middleware({ params: { id: 'alpha' }, user: { role: 'read_only', projects: ['alpha'] } } as any, response, next);
    expect(response.status).toHaveBeenCalledWith(403);

    middleware({ params: { id: 'alpha' }, user: { role: 'developer', projects: ['alpha'] } } as any, response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
