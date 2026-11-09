import type { Request, Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { shieldTelemetry } from '../lib/shield-telemetry';

function record(method: string, path: string) {
  const req = { method, originalUrl: path, ip: '127.0.0.1', socket: {} } as unknown as Request;
  shieldTelemetry.recordRequest(req, { statusCode: 200 } as Response, 10);
}

describe('shieldTelemetry route metrics', () => {
  afterEach(() => shieldTelemetry.reset());

  it('names each route by the path that was called, grouped per table or function', () => {
    record('GET', '/rest/v1/projects?select=*');
    record('GET', '/rest/v1/projects?id=eq.1');
    record('POST', '/api/edge/send-invoice');
    record('GET', '/api/users?page=2');

    const routes = shieldTelemetry.summarize().routes.map(route => [route.route, route.count]);

    expect(routes).toEqual([
      ['GET /rest/v1/projects', 2],
      ['POST /api/edge/send-invoice', 1],
      ['GET /api/users', 1],
    ]);
  });
});
