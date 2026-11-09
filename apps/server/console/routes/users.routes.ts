import { Router, Request, Response, RequestHandler } from 'express';
import { isUserRole, sessionUser } from '../auth/session';
import { MIN_PASSWORD } from '../constants';
import { PlatformUsersService, UserRole, toPublicUser } from '../services/users.service';
import { sendInternalError, type ErrorLogSink } from '../helpers/internal-error.helper';
import { errorMessage } from '../../lib/errors';
import { requireCapability } from '../auth/capabilities';
import { auditMutations, type AuditMutation } from '../middlewares/audit.middleware';
import type { AuditStore } from '../services/audit.service';
import { fail, ok } from '../helpers/respond';


interface Deps {
  users: PlatformUsersService;
  requireSession: RequestHandler;
  logs?: ErrorLogSink;
  audit?: AuditStore;
}

function safeUserTarget(value: unknown): string {
  const valid = typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
  return `user:${valid ? value : 'unknown'}`;
}

/** Classifies user mutations without ever copying credentials into audit data. */
function classifyUserMutation(req: Request): AuditMutation {
  if (req.method === 'POST' && req.path === '/') {
    const email = typeof req.body?.email === 'string' && /^[^\s@]+@[^\s@]+$/.test(req.body.email) && req.body.email.length <= 254
      ? req.body.email.trim().toLowerCase()
      : 'unknown';
    return {
      action: 'user.create',
      target: `user:${email}`,
      detail: {
        role: isUserRole(req.body?.role) ? req.body.role : 'invalid',
        projectCount: Array.isArray(req.body?.projects) ? req.body.projects.length : 0,
      },
    };
  }
  const sessions = req.path.match(/^\/([^/]+)\/sessions$/);
  if (req.method === 'DELETE' && sessions) {
    return { action: 'user.sessions.revoke', target: safeUserTarget(sessions[1]) };
  }
  const user = req.path.match(/^\/([^/]+)$/);
  if (user && req.method === 'PATCH') {
    const fields = ['role', 'projects', 'disabled'].filter(key => req.body?.[key] !== undefined);
    if (req.body?.password !== undefined) fields.push('passwordReset');
    return { action: 'user.update', target: safeUserTarget(user[1]), detail: { fields } };
  }
  if (user && req.method === 'DELETE') {
    return { action: 'user.delete', target: safeUserTarget(user[1]) };
  }
  return { action: 'user.mutation', target: 'user:unknown' };
}

// Owner-only user management. Passwords are never returned in any response.
export function usersRouter(deps: Deps): Router {
  const r = Router();
  r.use(deps.requireSession);
  r.use(auditMutations(deps.audit, classifyUserMutation, deps.logs));
  r.use(requireCapability('users.manage'));

  r.get('/', async (_req: Request, res: Response) => {
    try {
      return ok(res, (await deps.users.list()).map(toPublicUser));
    } catch (error: unknown) {
      return sendInternalError(res, deps.logs, 'user management request failed', error);
    }
  });

  r.post('/', async (req: Request, res: Response) => {
    const { email, password, role, projects } = req.body ?? {};
    if (typeof email !== 'string' || !email.trim()) return fail(res, 400, 'email is required');
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
      return fail(res, 400, `password must be at least ${MIN_PASSWORD} characters`);
    }
    if (!isUserRole(role)) return fail(res, 400, 'invalid role');
    if (projects !== undefined && !Array.isArray(projects)) return fail(res, 400, 'projects must be an array');
    try {
      const user = await deps.users.create({
        email: email.trim(),
        password,
        role,
        projects,
        passwordTemporary: true,
      });
      return res.status(201).json({ success: true, data: toPublicUser(user) });
    } catch (error: unknown) {
      if (/already exists/i.test(errorMessage(error))) return fail(res, 409, 'email already exists');
      return sendInternalError(res, deps.logs, 'user creation failed', error);
    }
  });

  r.patch('/:id', async (req: Request, res: Response) => {
    const { role, projects, disabled, password } = req.body ?? {};
    const patch: {
      role?: UserRole;
      projects?: string[];
      disabled?: boolean;
      password?: string;
      passwordTemporary?: boolean;
    } = {};
    if (role !== undefined) {
      if (!isUserRole(role)) return fail(res, 400, 'invalid role');
      patch.role = role;
    }
    if (projects !== undefined) {
      if (!Array.isArray(projects)) return fail(res, 400, 'projects must be an array');
      patch.projects = projects;
    }
    if (disabled !== undefined) {
      if (typeof disabled !== 'boolean') return fail(res, 400, 'disabled must be a boolean');
      patch.disabled = disabled;
    }
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
        return fail(res, 400, `password must be at least ${MIN_PASSWORD} characters`);
      }
      patch.password = password;
      patch.passwordTemporary = true;
    }
    try {
      const target = await deps.users.findById(req.params.id);
      if (!target) return fail(res, 404, 'user not found');
      // Prevent demoting/disabling the last owner into an unusable console.
      if (target.role === 'owner' && (await deps.users.ownerCount()) <= 1) {
        if (patch.role !== undefined && patch.role !== 'owner') return fail(res, 400, 'cannot change the role of the last owner');
        if (patch.disabled === true) return fail(res, 400, 'cannot disable the last owner');
      }
      const updated = await deps.users.update(req.params.id, patch);
      if (!updated) return fail(res, 404, 'user not found');
      return ok(res, toPublicUser(updated));
    } catch (error: unknown) {
      return sendInternalError(res, deps.logs, 'user management request failed', error);
    }
  });

  r.delete('/:id/sessions', async (req: Request, res: Response) => {
    const me = sessionUser(req);
    if (me?.id === req.params.id) return fail(res, 400, 'use account settings to revoke your own sessions');
    try {
      if (!(await deps.users.revokeSessions(req.params.id))) return fail(res, 404, 'user not found');
      return ok(res, { id: req.params.id, revoked: true });
    } catch (error: unknown) {
      return sendInternalError(res, deps.logs, 'session revocation failed', error);
    }
  });

  r.delete('/:id', async (req: Request, res: Response) => {
    const me = sessionUser(req);
    try {
      const target = await deps.users.findById(req.params.id);
      if (!target) return fail(res, 404, 'user not found');
      if (me && target.id === me.id) return fail(res, 400, 'cannot delete your own account');
      if (target.role === 'owner' && (await deps.users.ownerCount()) <= 1) {
        return fail(res, 400, 'cannot delete the last owner');
      }
      const removed = await deps.users.delete(req.params.id);
      if (!removed) return fail(res, 404, 'user not found');
      return ok(res, { id: req.params.id, deleted: true });
    } catch (error: unknown) {
      return sendInternalError(res, deps.logs, 'user management request failed', error);
    }
  });

  return r;
}
