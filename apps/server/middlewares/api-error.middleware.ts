import type { ErrorRequestHandler, Request, Response } from 'express';
import { ApplicationError, defaultErrorCode } from '../exceptions/application-error';
import { describeError } from '../lib/errors';

export interface ApiErrorEnvelope {
  status: 0;
  code: string;
  message: string;
  /**
   * Correlation id, also sent as the `x-request-id` response header and printed
   * on the server-side log line. A masked 500 says nothing on its own; this is
   * what lets a caller quote one failing request back to the operator.
   */
  requestId?: string;
}

export interface ApiErrorLogEntry {
  error: unknown;
  method?: string;
  path?: string;
  statusCode: number;
  internalMessage: string;
  requestId?: string;
}

export interface ApiErrorOptions {
  isProduction: boolean;
  logger?: (entry: ApiErrorLogEntry) => void;
}

interface NormalizedApiError {
  statusCode: number;
  body: ApiErrorEnvelope;
  shouldLog: boolean;
  internalMessage: string;
}

export function apiErrorEnvelope(code: string, message: string, requestId?: string): ApiErrorEnvelope {
  return { status: 0, code, message, ...(requestId ? { requestId } : {}) };
}

export function normalizeApiError(
  error: unknown,
  isProduction: boolean,
  requestId?: string
): NormalizedApiError {
  const known = error instanceof ApplicationError;
  const statusCode = known ? validStatus(error.statusCode) : statusFromUnknown(error);
  const internalMessage = describeError(error);
  const message =
    known && error.expose
      ? error.message
      : // A recognised constraint failure gets a sentence that says what the
        // caller did wrong. It is a fixed string keyed off the SQLSTATE, so no
        // schema name, value or SQL text from the driver reaches the client.
        databasePublicMessage(error) ??
        (!isProduction && internalMessage ? internalMessage : defaultPublicMessage(statusCode));
  const code = known ? error.code : defaultErrorCode(statusCode);

  return {
    statusCode,
    body: apiErrorEnvelope(code, message, requestId),
    shouldLog: !known || statusCode >= 500,
    internalMessage,
  };
}

export function createApiErrorHandler(options: ApiErrorOptions): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, next) => {
    if (res.headersSent) return next(error);
    const normalized = normalizeApiError(error, options.isProduction, req.id);
    if (normalized.shouldLog) {
      options.logger?.({
        error,
        method: req.method,
        path: req.originalUrl,
        statusCode: normalized.statusCode,
        internalMessage: normalized.internalMessage,
        requestId: req.id,
      });
    }
    return res.status(normalized.statusCode).json(normalized.body);
  };
}

function statusFromUnknown(error: unknown): number {
  if (isRecord(error)) {
    if (error.name === 'UnauthorizedError') return 401;
    const databaseStatus = statusFromDatabaseCode(sqlState(error));
    if (databaseStatus) return databaseStatus;
    const candidate = error.statusCode ?? error.status;
    if (typeof candidate === 'number') return validStatus(candidate);
  }
  return 500;
}

/**
 * The Prisma client's own codes for the constraint failures it reports without
 * a SQLSTATE. A row insert into a Prisma model with a bad `userId` is a P2003,
 * and used to reach the console as a bare "Internal server error".
 */
const SQLSTATE_BY_PRISMA_CODE: Record<string, string> = {
  P2002: '23505', // unique constraint
  P2003: '23503', // foreign key constraint
  P2011: '23502', // null constraint
};

/**
 * The SQLSTATE behind a database error. `pg` puts it on `code`; a failed Prisma
 * raw query is a P2010 that carries it in `meta.code`. Both are read, so a
 * duplicate column from the schema editor is a client error and not a 500.
 */
function sqlState(error: unknown): unknown {
  if (!isRecord(error)) return undefined;
  const code = (isRecord(error.meta) ? error.meta.code : undefined) ?? error.code;
  return (typeof code === 'string' && SQLSTATE_BY_PRISMA_CODE[code]) || code;
}

function statusFromDatabaseCode(code: unknown): number | undefined {
  if (typeof code !== 'string') return undefined;
  const statuses: Record<string, number> = {
    '22001': 400, // string data right truncation
    '22P02': 400, // invalid text representation
    '23502': 400, // not-null violation
    '23503': 409, // foreign-key violation
    '23505': 409, // unique violation
    '23514': 400, // check violation
    '23P01': 409, // exclusion violation
    '40001': 409, // serialization failure
    '40P01': 409, // deadlock detected
    '42501': 403, // insufficient privilege / RLS policy violation
    '42701': 409, // duplicate column
    '42703': 400, // undefined column
    '42710': 409, // duplicate object (type, constraint, policy, trigger)
    '42P01': 404, // undefined table
    '42P06': 409, // duplicate schema
    '42P07': 409, // duplicate table, view or index
    '42883': 400, // undefined function
    '53300': 503, // too many connections
    '57014': 504, // query canceled (statement timeout)
  };
  return statuses[code];
}

/**
 * A user-facing sentence for the constraint failures a caller can actually fix.
 * Keyed purely by SQLSTATE: the driver's own message (which carries the SQL,
 * the offending value and the schema object names) is never part of the result,
 * so this stays safe for anonymous REST callers and stays identical in
 * development and production. The raw error is still logged internally.
 */
function databasePublicMessage(error: unknown): string | undefined {
  const code = sqlState(error);
  if (typeof code !== 'string') return undefined;
  const messages: Record<string, string> = {
    '22001': 'A value is longer than its column allows.',
    '22P02': 'A value has the wrong type for the column it was written to.',
    '23502': 'A required field was missing.',
    '23503': 'A referenced row does not exist, or is still referenced by other rows.',
    '23505': 'A record with these values already exists.',
    '23514': 'A value failed a check constraint on the table.',
    '23P01': 'This conflicts with an existing row that overlaps it.',
    '40001': 'The write conflicted with another concurrent write. Retry the request.',
    '40P01': 'The database detected a deadlock and cancelled this request. Retry it.',
    '42501': 'Row level security or table privileges blocked this operation.',
    '42701': 'A column with that name already exists on this table.',
    '42703': 'A column in the request does not exist on this table.',
    '42710': 'An object with that name already exists.',
    '42P01': 'That table or view does not exist.',
    '42P06': 'A schema with that name already exists.',
    '42P07': 'A table, view or index with that name already exists.',
    '42883': 'That database function does not exist, or the argument types do not match.',
    '53300': 'The database has no free connections. Retry in a moment.',
    '57014': 'The query ran past the statement timeout and was cancelled.',
  };
  return messages[code];
}

function validStatus(statusCode: number): number {
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 500;
}


function defaultPublicMessage(statusCode: number): string {
  const messages: Record<number, string> = {
    400: 'Bad request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Resource not found',
    409: 'Conflict',
    413: 'Payload too large',
    429: 'Too many requests',
  };
  return messages[statusCode] ?? (statusCode >= 500 ? 'Internal server error' : 'Request failed');
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}
