import { NextFunction, Request, Response } from 'express';

import { validationResult } from 'express-validator';
import * as apiResponse from '../helpers/api-response.helper';

export const validateRequest = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) {
    return next();
  }
  const validationMsg = errors
    .array()
    .map(err => err.msg)
    .join(', ');

  return apiResponse.validationErrorWithData(res, `Validation Errors:\n ${validationMsg}`, errors.array());
};
