import { before, GET, POST, PUT, DELETE, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import IContextContainer from '../../context/icontext-container';
import { adminOnly } from '../../middlewares/platform-admin.middleware';
import { parseRlsPolicyPreset } from '../../services/admin/rls.service';
import * as apiResponse from '../../helpers/api-response.helper';
import { parseBody } from '../../lib/zod-body';

/**
 * A policy on `realtime.messages`. SELECT decides who may receive on a private
 * channel and INSERT who may send, so those (and ALL) are the commands that
 * mean anything here.
 */
const realtimePolicySchema = z.object({
  name: z.string().trim().min(1).max(63),
  command: z.enum(['SELECT', 'INSERT', 'ALL']),
  role: z.enum(['anon', 'authenticated']),
  using: z.string().max(10_000).optional(),
  check: z.string().max(10_000).optional(),
});


@route('/api/admin')
export default class AdminSecurityController {
  constructor(private di: IContextContainer) {}

  @GET()
  @route('/rls/tables')
  @before(adminOnly)
  async rlsTables(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.RlsService.listTables());
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/rls/access')
  @before(adminOnly)
  async rlsAccess(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.RlsService.accessMatrix());
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/rls/policies')
  @before(adminOnly)
  async rlsCreatePolicy(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.RlsService.createPolicy(req.body);
      return apiResponse.successResponse(res, 'Created');
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PUT()
  @route('/rls/policies')
  @before(adminOnly)
  async rlsReplacePolicy(req: Request, res: Response, next: NextFunction) {
    try {
      const { prevName, ...input } = req.body;
      await this.di.RlsService.replacePolicy(prevName, input);
      return apiResponse.successResponse(res, 'Updated');
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/rls/policies')
  @before(adminOnly)
  async rlsDropPolicy(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.RlsService.dropPolicy(req.body.table, req.body.name);
      return apiResponse.successResponse(res, 'Dropped');
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/realtime/policies')
  @before(adminOnly)
  async realtimePolicies(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', { policies: await this.di.RlsService.listRealtimePolicies() });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/realtime/policies')
  @before(adminOnly)
  async realtimeCreatePolicy(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.RlsService.createRealtimePolicy(parseBody(realtimePolicySchema, req.body));
      return apiResponse.successResponse(res, 'Created');
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/realtime/policies/:name')
  @before(adminOnly)
  async realtimeDropPolicy(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.RlsService.dropRealtimePolicy(req.params.name);
      return apiResponse.successResponse(res, 'Dropped');
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/rls/tables/:table/rls')
  @before(adminOnly)
  async rlsToggle(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.RlsService.setRls(req.params.table, Boolean(req.body.enabled));
      return apiResponse.successResponse(res, 'OK');
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/rls/tables/:table/preset')
  @before(adminOnly)
  async rlsApplyPreset(req: Request, res: Response, next: NextFunction) {
    try {
      const { preset, ...options } = req.body ?? {};
      const result = await this.di.RlsService.applyPresetToTable(
        req.params.table,
        parseRlsPolicyPreset(preset),
        options
      );
      return apiResponse.successResponseWithData(res, 'Applied', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  /**
   * Executes caller-supplied SQL, so it stays behind `adminGuard`. The service
   * rejects anything that is not a single read and always rolls back, but the
   * feature's purpose (seeing the rows another user would see) is itself an
   * admin-only capability.
   */
  @POST()
  @route('/rls/simulate')
  @before(adminOnly)
  async rlsSimulate(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await this.di.RlsSimulatorService.simulate(req.body ?? {});
      return apiResponse.successResponseWithData(res, 'OK', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/rls/simulate/diff')
  @before(adminOnly)
  async rlsSimulateDiff(req: Request, res: Response, next: NextFunction) {
    try {
      const { sql, left, right } = req.body ?? {};
      const result = await this.di.RlsSimulatorService.diff(sql, left ?? {}, right ?? {});
      return apiResponse.successResponseWithData(res, 'OK', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/advisor')
  @before(adminOnly)
  async advisor(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.AdvisorService.run());
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ?range=15m|1h|24h scopes the traffic tables to the same period the caller is
  // charting. Omitted, it keeps the previous one-hour default.
  @GET()
  @route('/shield')
  @before(adminOnly)
  async shield(req: Request, res: Response, next: NextFunction) {
    try {
      const RANGES: Record<string, number> = { '15m': 15 * 60_000, '1h': 60 * 60_000, '24h': 24 * 60 * 60_000 };
      const windowMs = RANGES[String(req.query.range ?? '')];
      return apiResponse.successResponseWithData(res, 'OK', await this.di.ShieldService.run(windowMs));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/edge-secrets')
  @before(adminOnly)
  async listSecrets(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', { secrets: await this.di.SecretsService.list() });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PUT()
  @route('/edge-secrets')
  @before(adminOnly)
  async setSecret(req: Request, res: Response, next: NextFunction) {
    try {
      const saved = await this.di.SecretsService.set(req.body?.name, req.body?.value);
      return apiResponse.successResponseWithData(res, 'Saved', saved);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/edge-secrets/:name')
  @before(adminOnly)
  async deleteSecret(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.SecretsService.delete(decodeURIComponent(req.params.name));
      return apiResponse.successResponse(res, 'Deleted');
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ── Project API keys ───────────────────────────────────────────────────────

  @GET()
  @route('/api-keys')
  @before(adminOnly)
  async listApiKeys(_req: Request, res: Response, next: NextFunction) {
    try {
      // Reading the list is also what mints the default publishable key, so a
      // project that predates this feature shows a usable key on first visit
      // instead of an empty table with a "create one" button.
      await this.di.ApiKeyService.ensurePublishable();
      return apiResponse.successResponseWithData(res, 'OK', { keys: await this.di.ApiKeyService.list() });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/api-keys')
  @before(adminOnly)
  async createApiKey(req: Request, res: Response, next: NextFunction) {
    try {
      const created = await this.di.ApiKeyService.create(req.body?.name, req.body?.type);
      // `clearToken` is the only time a secret key is ever readable.
      return apiResponse.successResponseWithData(res, 'Created', created);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/api-keys/:id')
  @before(adminOnly)
  async revokeApiKey(req: Request, res: Response, next: NextFunction) {
    try {
      const revoked = await this.di.ApiKeyService.revoke(req.params.id);
      return apiResponse.successResponseWithData(res, 'Revoked', revoked);
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ── Database connection ────────────────────────────────────────────────────

  @GET()
  @route('/database/connection')
  @before(adminOnly)
  async databaseConnection(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', this.di.DbConnectionService.get());
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ── Storage (S3/MinIO) connection ──────────────────────────────────────────

  @GET()
  @route('/storage/connection')
  @before(adminOnly)
  async storageConnection(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', this.di.StorageConnectionService.get());
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ── pg_cron ────────────────────────────────────────────────────────────────
}
