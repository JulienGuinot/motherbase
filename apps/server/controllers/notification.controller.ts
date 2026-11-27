import { before, POST, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { UserRole } from '@prisma/client';
import IContextContainer from '../context/icontext-container';
import { authMiddleware, optionalAuthMiddleware } from '../middlewares/auth.middleware';
import { apiKeyMiddleware } from '../middlewares/api-key.middleware';
import { getApiResponse } from '../helpers/http.helper';
import * as apiResponse from '../helpers/api-response.helper';
import { parseBody } from '../lib/zod-body';
import { sendNotificationSchema, testNotificationSchema } from '../validators/device.validators';

/**
 * Sending to other users is for the project's back end: a secret API key (an
 * edge function, a server, a cron job) or a signed-in user with the ADMIN role.
 */
export function secretKeyOrProjectAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.apiKey?.type === 'secret') return next();
  if (!req.user) return apiResponse.unauthorizedResponse(res, 'Unauthorized');
  if (req.user.role !== UserRole.ADMIN) {
    return apiResponse.unauthorizedResponse(res, 'Forbidden: needs a secret API key or the ADMIN role');
  }
  return next();
}

@route('/api/notifications')
export default class NotificationController {
  constructor(private di: IContextContainer) {}

  // A push to one user (`userId`) or up to 1000 (`userIds`).
  @POST()
  @route('/send')
  @before([apiKeyMiddleware, optionalAuthMiddleware, secretKeyOrProjectAdmin])
  async send(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId, userIds, title, body, data } = parseBody(sendNotificationSchema, req.body);
      const response = await this.di.NotificationService.sendToUsers(userIds ?? [userId!], { title, body, data });
      return getApiResponse(res, response);
    } catch (error: unknown) {
      return next(error);
    }
  }

  // Send a push to the authenticated user's own devices (handy for testing).
  @POST()
  @route('/test')
  @before([authMiddleware])
  async test(req: Request, res: Response, next: NextFunction) {
    try {
      const { title, body, data } = parseBody(testNotificationSchema, req.body);
      const response = await this.di.NotificationService.sendToUser(req.user!.id, { title, body, data });
      return getApiResponse(res, response);
    } catch (error: unknown) {
      return next(error);
    }
  }
}
