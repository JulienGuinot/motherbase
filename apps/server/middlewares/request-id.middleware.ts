import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';

/**
 * Correlation id for one request.
 *
 * A 500 used to reach the client as `{"status":0,"code":"INTERNAL_ERROR",
 * "message":"Internal server error"}` with nothing tying it to the stack trace
 * sitting in the log buffer: on an intermittent failure you had to guess which
 * line belonged to which call. Every response now carries `x-request-id`, and
 * the same id is on the log line and in the error envelope.
 */
declare global {
  namespace Express {
    interface Request {
      /** Correlation id, set by `requestId` for every request. */
      id?: string;
    }
  }
}

/**
 * An inbound id is honoured so a trace started upstream (a gateway, a client
 * SDK, another service) stays one trace, but it is echoed into a response
 * header, so it is bounded and restricted to characters that cannot smuggle a
 * header break.
 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function requestIdFrom(header: unknown): string {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && SAFE_ID.test(value) ? value : randomUUID();
}

export const requestId = (req: Request, res: Response, next: NextFunction) => {
  const id = requestIdFrom(req.headers['x-request-id']);
  req.id = id;
  res.setHeader('x-request-id', id);
  next();
};
