import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '../exceptions/application-error';
import { HttpException } from '../exceptions/http-exception';
import {
  type ApiErrorLogEntry,
  createApiErrorHandler,
} from '../middlewares/api-error.middleware';

function appThrowing(error: unknown, logger = vi.fn<(entry: ApiErrorLogEntry) => void>()) {
  const app = express();
  app.get('/boom', (_req, _res, next) => next(error));
  app.use(createApiErrorHandler({ isProduction: true, logger }));
  return { app, logger };
}

describe('API error middleware', () => {
  it.each([[400, 'BAD_REQUEST'], [401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND']] as const)(
    'uses the same default code for known and unknown HTTP %s errors', async (status, code) => {
      for (const error of [new HttpException('Rejected', status), { status }]) {
        const { app } = appThrowing(error);
        expect((await request(app).get('/boom')).body.code).toBe(code);
      }
    },
  );
  it.each([
    {
      error: new HttpException('Invalid payload', 400, 'BAD_REQUEST'),
      statusCode: 400,
      code: 'BAD_REQUEST',
      message: 'Invalid payload',
    },
    {
      error: new ApplicationError(401, 'Authentication required', { code: 'UNAUTHORIZED' }),
      statusCode: 401,
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    },
    {
      error: new HttpException('File not found', 404, 'NOT_FOUND'),
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'File not found',
    },
    {
      error: new HttpException('Email already exists', 409, 'CONFLICT'),
      statusCode: 409,
      code: 'CONFLICT',
      message: 'Email already exists',
    },
  ])('preserves a $statusCode ApplicationError without leaking a stack', async ({
    error,
    statusCode,
    code,
    message,
  }) => {
    const { app, logger } = appThrowing(error);

    const response = await request(app).get('/boom');

    expect(response.status).toBe(statusCode);
    expect(response.body).toEqual({ status: 0, code, message });
    expect(JSON.stringify(response.body)).not.toContain('at ');
    expect(response.body).not.toHaveProperty('stack');
    expect(logger).not.toHaveBeenCalled();
  });

  it('masks an unknown SQL failure in production and logs its diagnostic internally', async () => {
    const sqlError = new Error(
      'duplicate key value violates unique constraint "users_email_key"; password=database-secret',
    );
    sqlError.stack =
      'Error: duplicate key value violates unique constraint "users_email_key"\n' +
      '    at Query.run (/srv/app/database.ts:42:7)';
    const { app, logger } = appThrowing(sqlError);

    const response = await request(app).get('/boom');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      status: 0,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
    expect(JSON.stringify(response.body)).not.toContain('users_email_key');
    expect(JSON.stringify(response.body)).not.toContain('database-secret');
    expect(JSON.stringify(response.body)).not.toContain('/srv/app');
    expect(response.body).not.toHaveProperty('stack');

    expect(logger).toHaveBeenCalledOnce();
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        error: sqlError,
        method: 'GET',
        path: '/boom',
        statusCode: 500,
        internalMessage: expect.stringContaining('users_email_key'),
      }),
    );
  });

  it.each([
    ['42501', 403, 'FORBIDDEN'],
    ['23505', 409, 'CONFLICT'],
    ['23503', 409, 'CONFLICT'],
    ['23502', 400, 'BAD_REQUEST'],
    ['22P02', 400, 'BAD_REQUEST'],
  ])('maps PostgreSQL code %s without exposing its internal message', async (code, statusCode, publicCode) => {
    const databaseError = Object.assign(new Error('sensitive SQL detail'), { code });
    const { app, logger } = appThrowing(databaseError);

    const response = await request(app).get('/boom');

    expect(response.status).toBe(statusCode);
    expect(response.body).toMatchObject({ status: 0, code: publicCode });
    expect(response.body.message).not.toContain('sensitive SQL detail');
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({ error: databaseError, statusCode }));
  });

  it.each([
    ['23505', 'A record with these values already exists.'],
    ['23502', 'A required field was missing.'],
    ['42501', 'Row level security or table privileges blocked this operation.'],
    ['57014', 'The query ran past the statement timeout and was cancelled.'],
  ])('explains PostgreSQL code %s instead of returning a bare status word', async (code, message) => {
    const databaseError = Object.assign(new Error('sensitive SQL detail'), { code });
    const { app } = appThrowing(databaseError);

    const response = await request(app).get('/boom');

    expect(response.body.message).toBe(message);
  });

  it('reads the SQLSTATE a failed Prisma raw query carries in meta', async () => {
    // What `$executeRawUnsafe` throws for ALTER TABLE ... ADD COLUMN on a name already taken.
    const prismaError = Object.assign(new Error('Raw query failed. Code: `42701`.'), {
      code: 'P2010',
      meta: { code: '42701', message: 'ERROR: column "status" of relation "registrations" already exists' },
    });
    const { app } = appThrowing(prismaError);

    const response = await request(app).get('/boom');

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CONFLICT', message: 'A column with that name already exists on this table.' });
  });

  it('maps a Prisma client constraint code to its SQLSTATE sentence', async () => {
    // What `prisma.device.create` throws for a userId with no matching user.
    const prismaError = Object.assign(new Error('Foreign key constraint violated: `devices_userId_fkey (index)`'), {
      code: 'P2003',
      meta: { field_name: 'devices_userId_fkey (index)' },
    });
    const { app } = appThrowing(prismaError);

    const response = await request(app).get('/boom');

    expect(response.status).toBe(409);
    expect(response.body.message).toBe('A referenced row does not exist, or is still referenced by other rows.');
  });

  it('keeps the driver message out of a constraint failure in development', async () => {
    const databaseError = Object.assign(
      new Error('duplicate key value violates unique constraint "users_email_key"'),
      { code: '23505' },
    );
    const app = express();
    app.get('/boom', (_req, _res, next) => next(databaseError));
    app.use(createApiErrorHandler({ isProduction: false }));

    const response = await request(app).get('/boom');

    expect(response.status).toBe(409);
    expect(response.body.message).toBe('A record with these values already exists.');
    expect(JSON.stringify(response.body)).not.toContain('users_email_key');
  });
});
