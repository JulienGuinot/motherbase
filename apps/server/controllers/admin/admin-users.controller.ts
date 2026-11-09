import { before, GET, POST, PATCH, DELETE, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import IContextContainer from '../../context/icontext-container';
import { adminOnly } from '../../middlewares/platform-admin.middleware';
import * as apiResponse from '../../helpers/api-response.helper';
import { HttpException } from '../../exceptions/http-exception';

// `per_page` on the wire, as the audit log spells it. Both are optional: the
// service clamps a missing value to a bounded first page.
const sessionsQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  per_page: z.coerce.number().int().min(1).max(500).optional(),
});

// Studio's users table. Without `page` the route answers with every user, which
// is what the CLI's `users list` prints.
const usersQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  per_page: z.coerce.number().int().min(1).max(500).optional(),
  q: z.string().trim().min(1).optional(),
  role: z.enum(['ADMIN', 'USER']).optional(),
  verified: z.enum(['true', 'false']).optional(),
  anonymous: z.enum(['true', 'false']).optional(),
});

@route('/api/admin')
export default class AdminUsersController {
  constructor(private di: IContextContainer) {}

  @GET()
  @route('/users')
  @before(adminOnly)
  async users(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = usersQuery.safeParse(req.query);
      if (!parsed.success) {
        throw new HttpException(`Invalid query, ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 400);
      }
      const { page, per_page: perPage, q, role, verified, anonymous } = parsed.data;
      if (page === undefined) {
        return apiResponse.successResponseWithData(res, 'OK', { users: await this.di.UserAdminService.list() });
      }
      const result = await this.di.UserAdminService.listPage({
        page,
        perPage,
        filter: {
          search: q,
          role,
          emailVerified: verified === undefined ? undefined : verified === 'true',
          anonymous: anonymous === undefined ? undefined : anonymous === 'true',
        },
      });
      return apiResponse.successResponseWithData(res, 'OK', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/users')
  @before(adminOnly)
  async createUser(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'Created', await this.di.UserAdminService.create(req.body));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/users/sessions')
  @before(adminOnly)
  async sessions(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = sessionsQuery.safeParse(req.query);
      if (!parsed.success) {
        throw new HttpException(`Invalid query, ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 400);
      }
      const result = await this.di.UserAdminService.listSessions({
        page: parsed.data.page,
        perPage: parsed.data.per_page,
      });
      return apiResponse.successResponseWithData(res, 'OK', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/users/:id')
  @before(adminOnly)
  async user(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.UserAdminService.detail(req.params.id));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/users/:id')
  @before(adminOnly)
  async updateUser(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(
        res,
        'Updated',
        await this.di.UserAdminService.update(req.params.id, req.body)
      );
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/users/:id/email-verification')
  @before(adminOnly)
  async setEmailVerified(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(
        res,
        'Verification updated',
        await this.di.UserAdminService.setEmailVerified(req.params.id, req.body?.emailVerified)
      );
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/users/:id/reset-password')
  @before(adminOnly)
  async resetPassword(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.UserAdminService.resetPassword(req.params.id, req.body?.password);
      return apiResponse.successResponse(res, 'Password updated');
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/users/:id/revoke-sessions')
  @before(adminOnly)
  async revokeSessions(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.UserAdminService.revokeSessions(req.params.id);
      return apiResponse.successResponse(res, 'Sessions revoked');
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/users/:id/sessions/:sessionId')
  @before(adminOnly)
  async revokeSession(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.UserAdminService.revokeSession(req.params.id, req.params.sessionId);
      return apiResponse.successResponse(res, 'Session revoked');
    } catch (error: unknown) {
      return next(error);
    }
  }

  // Opens a time-limited session as this user and returns its bearer token. The
  // console proxy gates it on `secrets.manage` and writes the audit entry (see
  // console/routes/proxy.routes.ts); the token itself is never audited or logged.
  @POST()
  @route('/users/:id/impersonate')
  @before(adminOnly)
  async impersonate(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = String((req as any).user?.id ?? 'platform');
      return apiResponse.successResponseWithData(
        res,
        'Impersonation session opened',
        await this.di.UserAdminService.impersonate(req.params.id, actor)
      );
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/users/:id/impersonate/stop')
  @before(adminOnly)
  async stopImpersonating(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.UserAdminService.stopImpersonating(req.body?.token);
      return apiResponse.successResponse(res, 'Impersonation ended');
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/users/:id/promote')
  @before(adminOnly)
  async promote(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(
        res,
        'Promoted',
        await this.di.UserAdminService.setRole(req.params.id, 'ADMIN')
      );
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/users/:id/demote')
  @before(adminOnly)
  async demote(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(
        res,
        'Demoted',
        await this.di.UserAdminService.setRole(req.params.id, 'USER')
      );
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/users/:id')
  @before(adminOnly)
  async deleteUser(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.UserAdminService.delete(req.params.id);
      return apiResponse.successResponse(res, 'User deleted');
    } catch (error: unknown) {
      return next(error);
    }
  }
}
