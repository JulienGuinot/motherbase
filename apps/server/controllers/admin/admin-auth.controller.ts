import { before, GET, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import IContextContainer from '../../context/icontext-container';
import { adminOnly } from '../../middlewares/platform-admin.middleware';
import * as apiResponse from '../../helpers/api-response.helper';
import { HttpException } from '../../exceptions/http-exception';
import { AUDIT_ACTIONS } from '../../auth/audit-actions';

const auditQuery = z.object({
  action: z.string().max(64).optional(),
  log_type: z.string().max(32).optional(),
  actor: z.string().max(320).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).optional(),
  per_page: z.coerce.number().int().min(1).max(500).optional(),
});

/** Project auth administration that is not a settings group: the audit trail. */
@route('/api/admin')
export default class AdminAuthController {
  constructor(private di: IContextContainer) {}

  /** `auth.audit_log_entries`, newest first. Studio → Authentication → Audit Logs. */
  @GET()
  @route('/auth/audit-logs')
  @before(adminOnly)
  async auditLogs(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = auditQuery.safeParse(req.query);
      if (!parsed.success) {
        throw new HttpException(`Invalid query, ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 400);
      }
      const q = parsed.data;
      const result = await this.di.AuthAuditService.list({
        action: q.action,
        logType: q.log_type,
        actor: q.actor,
        from: q.from,
        to: q.to,
        page: q.page,
        perPage: q.per_page,
      });
      return apiResponse.successResponseWithData(res, 'OK', { ...result, actions: AUDIT_ACTIONS });
    } catch (error: unknown) {
      return next(error);
    }
  }
}
