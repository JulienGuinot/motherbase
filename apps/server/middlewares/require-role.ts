import { Request, Response, NextFunction } from 'express';
import { UserRole } from '@prisma/client';
import * as apiResponse from '../helpers/api-response.helper';

/**
 * Route guard that allows only users whose role is in `roles`.
 * Must run after `authMiddleware`, which populates `req.user`.
 */
export const requireRole =
  (...roles: UserRole[]) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return apiResponse.unauthorizedResponse(res, 'Unauthorized');
    if (!roles.includes(req.user.role)) {
      return apiResponse.unauthorizedResponse(res, 'Forbidden: insufficient permissions');
    }
    return next();
  };
