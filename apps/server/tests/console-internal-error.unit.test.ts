import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { sendInternalError } from '../console/helpers/internal-error.helper';

describe('Console internal error responses', () => {
  it('keeps diagnostics in logs and returns a stable public message', async () => {
    const logs = { push: vi.fn() };
    const app = express();
    app.get('/failure', (_req, res) =>
      sendInternalError(res, logs, 'test request failed', new Error('postgres://secret@internal-host')),
    );

    const response = await request(app).get('/failure');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ success: false, message: 'Internal server error' });
    expect(JSON.stringify(response.body)).not.toContain('internal-host');
    expect(logs.push).toHaveBeenCalledWith({
      level: 'error',
      source: 'console',
      message: 'test request failed: postgres://secret@internal-host',
    });
  });
});
