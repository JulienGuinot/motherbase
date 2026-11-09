import type { RequestHandler } from 'express';
import { sessionUser, type UserRole } from './session';

export const CAPABILITIES = [
  'project.read',
  'project.create',
  'content.write',
  'settings.write',
  'runtime.manage',
  'secrets.manage',
  'project.delete',
  'users.manage',
  'audit.read',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ALL = new Set<Capability>(CAPABILITIES);
const ROLE_CAPABILITIES: Record<UserRole, ReadonlySet<Capability>> = {
  owner: ALL,
  admin: new Set([
    'project.read',
    'project.create',
    'content.write',
    'settings.write',
    'runtime.manage',
    'secrets.manage',
    'project.delete',
    'audit.read',
  ]),
  developer: new Set(['project.read', 'content.write']),
  member: new Set(['project.read', 'content.write']),
  read_only: new Set(['project.read']),
};

export function capabilitiesForRole(role: UserRole): Capability[] {
  return CAPABILITIES.filter(capability => ROLE_CAPABILITIES[role]?.has(capability));
}

export function hasCapability(role: UserRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.has(capability) ?? false;
}

export function hasProjectScope(role: UserRole, projects: readonly string[], projectId: string): boolean {
  return role === 'owner' || role === 'admin' || projects.includes(projectId);
}

export function requireCapability(capability: Capability): RequestHandler {
  return (req, res, next) => {
    const user = sessionUser(req);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });
    if (!hasCapability(user.role, capability)) return res.status(403).json({ success: false, message: 'Forbidden' });
    return next();
  };
}

export function requireProjectCapability(capability: Capability): RequestHandler {
  return (req, res, next) => {
    const user = sessionUser(req);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const projectId = req.params.id;
    if (!hasCapability(user.role, capability) || !projectId || !hasProjectScope(user.role, user.projects, projectId)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    return next();
  };
}
