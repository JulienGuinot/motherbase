import { before, DELETE, GET, PATCH, POST, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { HTTP_ROUTES } from '@motherbase/contracts';
import IContextContainer from '../context/icontext-container';
import { apiKeyMiddleware, requireSecretKey } from '../middlewares/api-key.middleware';
import { authLimiter } from '../middlewares/rate-limit';
import { HttpException } from '../exceptions/http-exception';
import * as apiResponse from '../helpers/api-response.helper';
import { generateLinkSchema } from '../services/admin/auth-link.service';

/**
 * `auth.admin.*`: user administration for trusted server code.
 *
 * The gap this closes: every Supabase backend has a file that creates users,
 * flips a role or deletes an account with the service key. Until now the only
 * way to do that here was the Studio admin API, which is an operator surface
 * with operator authentication, not something an application server can call.
 *
 * The guard is a **secret project API key and nothing else**, not an operator
 * session, and not a publishable key. That is narrower than Supabase's
 * `service_role`, which also opens SQL and DDL. Keeping the two apart means a
 * leaked application key cannot drop a table.
 *
 * Every handler delegates to `UserAdminService`, the same service Studio uses,
 * so the two surfaces cannot drift on what a user is or on which fields a patch
 * is allowed to touch.
 */
const secretKeyOnly = [apiKeyMiddleware, requireSecretKey, authLimiter];

/**
 * A secret project key must not mint or promote an ADMIN user: `adminGuard`
 * accepts any ADMIN user JWT on `/api/admin`, so a leaked application key would
 * otherwise reach SQL, DDL and backups. ADMIN is granted from the Studio
 * (`admin-users.controller`), behind the admin guard. Checked before any write.
 */
function refuseAdminRole(role: unknown) {
  if (role === 'ADMIN') throw new HttpException('A secret API key cannot assign the ADMIN role', 403);
}

@route(HTTP_ROUTES.authAdmin)
export default class AuthAdminController {
  constructor(private di: IContextContainer) {}

  @GET()
  @route('/users')
  @before(secretKeyOnly)
  async listUsers(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await this.di.UserAdminService.listPage({
        page: Number(req.query.page),
        perPage: Number(req.query.per_page ?? req.query.perPage),
      });
      return apiResponse.successResponseWithData(res, 'OK', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/users/:id')
  @before(secretKeyOnly)
  async getUserById(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', {
        user: await this.di.UserAdminService.detail(req.params.id),
      });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/users')
  @before(secretKeyOnly)
  async createUser(req: Request, res: Response, next: NextFunction) {
    try {
      refuseAdminRole(req.body?.role);
      const created = await this.di.UserAdminService.create({
        email: req.body?.email,
        username: req.body?.username,
        password: req.body?.password,
        role: req.body?.role,
        emailVerified: req.body?.email_confirm ?? req.body?.emailVerified,
        sendInvite: Boolean(req.body?.sendInvite),
      });
      return apiResponse.successResponseWithData(res, 'Created', created);
    } catch (error: unknown) {
      return next(error);
    }
  }

  /**
   * Profile fields, password and role in one call, because that is the shape
   * supabase-js callers already write. Each one is routed to the method that
   * owns it rather than merged into a single Prisma update: `update()` refuses
   * to write `role` on purpose, and going around that here would reintroduce
   * exactly the privilege-escalation path its allowlist exists to close.
   */
  @PATCH()
  @route('/users/:id')
  @before(secretKeyOnly)
  async updateUserById(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const body = req.body ?? {};
      refuseAdminRole(body.role);
      let user = await this.di.UserAdminService.update(id, {
        firstName: body.firstName,
        lastName: body.lastName,
        username: body.username,
        status: body.status,
      });
      if (body.password !== undefined) {
        user = await this.di.UserAdminService.resetPassword(id, String(body.password));
      }
      if (body.role !== undefined) {
        if (body.role !== 'ADMIN' && body.role !== 'USER') {
          throw new HttpException("role must be 'ADMIN' or 'USER'", 400);
        }
        user = await this.di.UserAdminService.setRole(id, body.role);
      }
      return apiResponse.successResponseWithData(res, 'Updated', { user });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/users/:id')
  @before(secretKeyOnly)
  async deleteUser(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.UserAdminService.delete(req.params.id);
      return apiResponse.successResponse(res, 'Deleted');
    } catch (error: unknown) {
      return next(error);
    }
  }

  /** Ends every session this user holds. The supabase-js `signOut` equivalent. */
  @POST()
  @route('/users/:id/sign-out')
  @before(secretKeyOnly)
  async signOutUser(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.UserAdminService.revokeSessions(req.params.id);
      return apiResponse.successResponse(res, 'Signed out');
    } catch (error: unknown) {
      return next(error);
    }
  }

  /** supabase-js `admin.mfa.listFactors({ userId })`. */
  @GET()
  @route('/users/:id/factors')
  @before(secretKeyOnly)
  async listFactors(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', {
        factors: await this.di.UserAdminService.listFactors(req.params.id),
      });
    } catch (error: unknown) {
      return next(error);
    }
  }

  /** supabase-js `admin.mfa.deleteFactor({ userId, id })`. */
  @DELETE()
  @route('/users/:id/factors/:factorId')
  @before(secretKeyOnly)
  async deleteFactor(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(
        res,
        'Deleted',
        await this.di.UserAdminService.deleteFactor(req.params.id, req.params.factorId),
      );
    } catch (error: unknown) {
      return next(error);
    }
  }

  /** supabase-js `admin.generateLink()`: the link an auth email would carry, returned instead of sent. */
  @POST()
  @route('/generate-link')
  @before(secretKeyOnly)
  async generateLink(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = generateLinkSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new HttpException(parsed.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 400);
      }
      return apiResponse.successResponseWithData(res, 'OK', await this.di.AuthLinkService.generate(parsed.data));
    } catch (error: unknown) {
      return next(error);
    }
  }

  /** Creates the account and emails the temporary password. */
  @POST()
  @route('/invite')
  @before(secretKeyOnly)
  async inviteUserByEmail(req: Request, res: Response, next: NextFunction) {
    try {
      refuseAdminRole(req.body?.role);
      const created = await this.di.UserAdminService.create({
        email: req.body?.email,
        username: req.body?.username,
        role: req.body?.role,
        sendInvite: true,
      });
      // The temporary password went out by email. Returning it here as well
      // would put a live credential in the caller's logs for no gain.
      const { temporaryPassword, ...safe } = created;
      return apiResponse.successResponseWithData(res, 'Invited', safe);
    } catch (error: unknown) {
      return next(error);
    }
  }
}
