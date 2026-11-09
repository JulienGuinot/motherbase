import { Response } from 'express';
import { apiErrorEnvelope } from '../middlewares/api-error.middleware';

export const successResponse = (res: Response, msg: string): Response =>
  res.status(200).json({ status: 1, message: msg });

export const successResponseWithData = (res: Response, msg: string, data: Record<string, any>): Response =>
  res.status(200).json({ status: 1, message: msg, data });

export const acceptedResponseWithData = (res: Response, msg: string, data: Record<string, any>): Response =>
  res.status(202).json({ status: 1, message: msg, data });

export const validationErrorWithData = (res: Response, msg: string, data: Record<string, any>): Response =>
  res.status(400).json({ ...apiErrorEnvelope('VALIDATION_ERROR', msg), data });

export const unauthorizedResponse = (res: Response, msg: string): Response =>
  res.status(401).json(apiErrorEnvelope('UNAUTHORIZED', msg));
