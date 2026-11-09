import type { Response } from 'express';
import { sendInternalError, type ErrorLogSink } from './internal-error.helper';

/**
 * A refusal a console service can explain to the caller (bad input, a state
 * conflict), as opposed to a failure, whose detail belongs in the logs only.
 * Services throw it; `sendServiceError` turns it into the usual envelope.
 */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function sendServiceError(res: Response, logs: ErrorLogSink | undefined, context: string, error: unknown) {
  if (error instanceof HttpError) return res.status(error.status).json({ success: false, message: error.message });
  return sendInternalError(res, logs, context, error);
}
