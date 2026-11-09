import { Request, Response, NextFunction, RequestHandler } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import type { AuthInstance } from './instance';

const USER_ROLES = ['owner', 'admin', 'developer', 'read_only', 'member'] as const;
export type UserRole = (typeof USER_ROLES)[number];

const USER_ROLE_SET = new Set<unknown>(USER_ROLES);

export function isUserRole(role: unknown): role is UserRole {
  return USER_ROLE_SET.has(role);
}

export function coerceRole(role: unknown): UserRole {
  return isUserRole(role) ? role : 'read_only';
}

// The identity attached to a request after requireSession. Role and projects
// are always reloaded live from Better Auth on every request. Never trusted
// from a client. Stored on req.user at runtime (see sessionUser()).
export interface SessionUser {
  id: string;
  email: string;
  role: UserRole;
  projects: string[];
  mustChangePassword: boolean;
}

const PASSWORD_CHANGE_PATH = '/api/platform/account/password';
const AUTH_SESSION_ROUTES = new Map<string, string>([
  ['/api/auth/get-session', 'GET'],
  ['/api/auth/sign-out', 'POST'],
  ['/api/auth/two-factor/verify-totp', 'POST'],
  ['/api/auth/two-factor/verify-otp', 'POST'],
  ['/api/auth/two-factor/verify-backup-code', 'POST'],
]);

function passwordChangeRequired(res: Response) {
  return res.status(403).json({
    success: false,
    message: 'Password change required',
    code: 'PASSWORD_CHANGE_REQUIRED',
  });
}

function isAuthSessionRoute(method: string, path: string): boolean {
  return AUTH_SESSION_ROUTES.get(path) === method;
}

/** Block optional Better Auth account actions while a temporary password is active. */
export function enforcePasswordRotation(auth: AuthInstance): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const path = req.originalUrl.split('?')[0];
    if (isAuthSessionRoute(req.method, path)) return next();
    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      const user = session?.user as { mustChangePassword?: boolean } | undefined;
      return user?.mustChangePassword ? passwordChangeRequired(res) : next();
    } catch {
      // Authentication and endpoint-specific errors remain Better Auth's concern.
      return next();
    }
  };
}

/** Read the live session identity attached by requireSession. */
export function sessionUser(req: Request): SessionUser | undefined {
  return (req as any).user as SessionUser | undefined;
}

// Verify the Better Auth session, then attach a fresh identity to req.user with
// the live role (from the session's user) and the projects derived via the
// injected `projectsOf` lookup (org memberships live in PlatformUsersService). Rejects
// missing/invalid sessions with 401.
export function requireSession(
  auth: AuthInstance,
  projectsOf: (userId: string) => Promise<string[]>,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session?.user) return res.status(401).json({ success: false, message: 'Unauthorized' });
      const u = session.user as {
        id: string;
        email: string;
        role?: string;
        disabled?: boolean;
        mustChangePassword?: boolean;
      };
      if (u.disabled) return res.status(401).json({ success: false, message: 'Unauthorized' });
      const mustChangePassword = Boolean(u.mustChangePassword);
      if (mustChangePassword && req.originalUrl.split('?')[0] !== PASSWORD_CHANGE_PATH) {
        return passwordChangeRequired(res);
      }
      (req as any).user = {
        id: u.id,
        email: u.email,
        role: coerceRole(u.role),
        projects: mustChangePassword ? [] : await projectsOf(u.id),
        mustChangePassword,
      } as SessionUser;
      return next();
    } catch {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
  };
}
