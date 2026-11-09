export interface ApplicationErrorOptions {
  code?: string;
  expose?: boolean;
  cause?: unknown;
}

export class ApplicationError extends Error {
  readonly code: string;
  readonly expose: boolean;
  readonly cause?: unknown;

  constructor(public readonly statusCode: number, message: string, options: ApplicationErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? defaultErrorCode(statusCode);
    this.expose = options.expose ?? statusCode < 500;
    this.cause = options.cause;
    Error.captureStackTrace?.(this, new.target);
  }
}

export function defaultErrorCode(statusCode: number): string {
  const codes: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    413: 'PAYLOAD_TOO_LARGE',
    429: 'RATE_LIMITED',
  };
  return codes[statusCode] ?? (statusCode >= 500 ? 'INTERNAL_ERROR' : `HTTP_${statusCode}`);
}
