import { before, GET, POST, PUT, PATCH, DELETE, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import IContextContainer from '../../context/icontext-container';
import { adminOnly } from '../../middlewares/platform-admin.middleware';
import * as apiResponse from '../../helpers/api-response.helper';

// Project infrastructure that Supabase keeps under Project Settings: JWT
// signing keys, database network access, log drains. Each surface has its own
// service; this controller is only their HTTP shape.
@route('/api/admin')
export default class AdminInfrastructureController {
  constructor(private di: IContextContainer) {}

  // ── JWT signing keys ───────────────────────────────────────────────────────

  @GET()
  @route('/auth/signing-keys')
  @before(adminOnly)
  async signingKeys(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.SigningKeyService.list());
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/auth/signing-keys')
  @before(adminOnly)
  async createSigningKey(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'Created', await this.di.SigningKeyService.create(req.body));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/auth/signing-keys/:id/rotate')
  @before(adminOnly)
  async rotateSigningKey(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'Rotated', await this.di.SigningKeyService.rotate(req.params.id));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/auth/signing-keys/:id/revoke')
  @before(adminOnly)
  async revokeSigningKey(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'Revoked', await this.di.SigningKeyService.revoke(req.params.id));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/auth/signing-keys/:id')
  @before(adminOnly)
  async deleteSigningKey(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'Deleted', await this.di.SigningKeyService.remove(req.params.id));
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ── Database network access ────────────────────────────────────────────────

  @GET()
  @route('/network-restrictions')
  @before(adminOnly)
  async networkRestrictions(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.DatabaseAccessService.networkRestrictions());
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PUT()
  @route('/network-restrictions')
  @before(adminOnly)
  async updateNetworkRestrictions(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await this.di.DatabaseAccessService.updateNetworkRestrictions(req.body);
      return apiResponse.successResponseWithData(res, 'Updated', data);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/ssl-enforcement')
  @before(adminOnly)
  async sslEnforcement(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.DatabaseAccessService.sslEnforcement());
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PUT()
  @route('/ssl-enforcement')
  @before(adminOnly)
  async updateSslEnforcement(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'Updated', await this.di.DatabaseAccessService.updateSslEnforcement(req.body));
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ── Log drains ─────────────────────────────────────────────────────────────

  @GET()
  @route('/log-drains')
  @before(adminOnly)
  async logDrains(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', { drains: await this.di.LogDrainService.list() });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/log-drains')
  @before(adminOnly)
  async createLogDrain(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'Created', await this.di.LogDrainService.create(req.body));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/log-drains/:id')
  @before(adminOnly)
  async updateLogDrain(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'Updated', await this.di.LogDrainService.update(req.params.id, req.body));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/log-drains/:id')
  @before(adminOnly)
  async deleteLogDrain(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'Deleted', await this.di.LogDrainService.remove(req.params.id));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/log-drains/:id/test')
  @before(adminOnly)
  async testLogDrain(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.LogDrainService.test(req.params.id));
    } catch (error: unknown) {
      return next(error);
    }
  }
}
