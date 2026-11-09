import { ServiceResponse } from '../types/http.types';
import * as apiResponse from '../helpers/api-response.helper';
import { Response } from 'express';
import { apiErrorEnvelope } from '../middlewares/api-error.middleware';
import { defaultErrorCode } from '../exceptions/application-error';

export const getApiResponse = (res: Response, response: ServiceResponse) => {
  if (response.data) return apiResponse.successResponseWithData(res, response.message, response.data);
  // Honor an explicit status from the service (e.g. 401 for bad credentials);
  // default failures to 400 (client error) rather than masking them as 500.
  const status = response.statusCode ?? 400;
  return res.status(status).json(apiErrorEnvelope(defaultErrorCode(status), response.message, res.req?.id));
};
