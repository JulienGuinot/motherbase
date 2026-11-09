import { before, DELETE, POST, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { DevicePlatform } from '@prisma/client';
import IContextContainer from '../context/icontext-container';
import { authMiddleware } from '../middlewares/auth.middleware';
import { validateRequest } from '../middlewares/validate-request';
import { getApiResponse } from '../helpers/http.helper';
import { registerDeviceValidator, unregisterDeviceValidator } from '../validators/device.validators';

@route('/api/devices')
export default class DeviceController {
  constructor(private di: IContextContainer) {}

  @POST()
  @route('/')
  @before([authMiddleware, registerDeviceValidator, validateRequest])
  async register(req: Request<{}, {}, { token: string; platform: DevicePlatform }>, res: Response, next: NextFunction) {
    try {
      const { token, platform } = req.body;
      const response = await this.di.NotificationService.registerDevice(req.user!.id, token, platform);
      return getApiResponse(res, response);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/')
  @before([authMiddleware, unregisterDeviceValidator, validateRequest])
  async unregister(req: Request<{}, {}, { token: string }>, res: Response, next: NextFunction) {
    try {
      const response = await this.di.NotificationService.unregisterDevice(req.body.token, req.user!.id);
      return getApiResponse(res, response);
    } catch (error: unknown) {
      return next(error);
    }
  }
}
