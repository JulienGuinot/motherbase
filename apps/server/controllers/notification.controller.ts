import { before, POST, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { UserRole } from '@prisma/client';
import IContextContainer from '../context/icontext-container';
import { authMiddleware } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/require-role';
import { validateRequest } from '../middlewares/validate-request';
import { getApiResponse } from '../helpers/http.helper';
import { sendNotificationValidator, testNotificationValidator } from '../validators/device.validators';

interface SendBody {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

@route('/api/notifications')
export default class NotificationController {
  constructor(private di: IContextContainer) {}

  // Admin-only: send a push to any user.
  @POST()
  @route('/send')
  @before([authMiddleware, requireRole(UserRole.ADMIN), sendNotificationValidator, validateRequest])
  async send(req: Request<{}, {}, SendBody>, res: Response, next: NextFunction) {
    try {
      const { userId, title, body, data } = req.body;
      const response = await this.di.NotificationService.sendToUser(userId, { title, body, data });
      return getApiResponse(res, response);
    } catch (error: unknown) {
      return next(error);
    }
  }

  // Send a push to the authenticated user's own devices (handy for testing).
  @POST()
  @route('/test')
  @before([authMiddleware, testNotificationValidator, validateRequest])
  async test(req: Request<{}, {}, { title: string; body: string; data?: Record<string, string> }>, res: Response, next: NextFunction) {
    try {
      const { title, body, data } = req.body;
      const response = await this.di.NotificationService.sendToUser(req.user!.id, { title, body, data });
      return getApiResponse(res, response);
    } catch (error: unknown) {
      return next(error);
    }
  }
}
