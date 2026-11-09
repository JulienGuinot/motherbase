import { describe, expect, it } from 'vitest';
import { requestId, requestIdFrom } from '../middlewares/request-id.middleware';
import { normalizeApiError } from '../middlewares/api-error.middleware';

describe('requestIdFrom', () => {
  it('keeps a sane inbound id so an upstream trace stays one trace', () => {
    expect(requestIdFrom('abc-123_x.9')).toBe('abc-123_x.9');
    expect(requestIdFrom(['first', 'second'])).toBe('first');
  });

  it('generates one rather than echoing anything that could break a header', () => {
    for (const bad of ['a\r\nX-Injected: 1', 'a'.repeat(65), '', undefined, 42]) {
      const id = requestIdFrom(bad as unknown);
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('requestId middleware', () => {
  it('sets req.id and the response header to the same value', () => {
    const req = { headers: {} } as any;
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => { headers[k] = v; } } as any;
    requestId(req, res, () => {});
    expect(req.id).toBe(headers['x-request-id']);
    expect(req.id).toBeTruthy();
  });
});

describe('error envelope correlation', () => {
  it('carries the request id on a masked 500', () => {
    const { body } = normalizeApiError(new Error('boom'), true, 'req-1');
    expect(body).toEqual({ status: 0, code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: 'req-1' });
  });

  it('omits the field when there is no id', () => {
    const { body } = normalizeApiError(new Error('boom'), true);
    expect(body).not.toHaveProperty('requestId');
  });
});
