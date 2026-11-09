import type { Response } from 'express';
import { errorMessage } from '../../lib/errors';

export interface ErrorLogSink {
  push(entry: { level: 'error'; source: string; message: string }): void;
}

export function sendInternalError(
  res: Response,
  logs: ErrorLogSink | undefined,
  context: string,
  error: unknown,
) {
  logs?.push({
    level: 'error',
    source: 'console',
    message: `${context}: ${errorMessage(error)}`,
  });
  return res.status(500).json({ success: false, message: 'Internal server error' });
}
