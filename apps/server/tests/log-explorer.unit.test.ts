import { describe, expect, it } from 'vitest';
import { LogBuffer } from '../lib/log-buffer';
import { logCursor, logFilterWhere, matchesLogFilter, parseLogCursor, parseStatusFilter } from '../lib/log-filter';
import { logServiceOf } from '../lib/log-services';

describe('logServiceOf', () => {
  it('files a request under the service its path reached', () => {
    expect(logServiceOf({ source: 'http', path: '/rest/v1/todos' })).toBe('rest');
    expect(logServiceOf({ source: 'http', path: '/api/auth/sign-in/email' })).toBe('auth');
    expect(logServiceOf({ source: 'http', path: '/api/storage/avatars/files/a.png' })).toBe('storage');
    expect(logServiceOf({ source: 'http', path: '/api/edge/hello' })).toBe('edge-function');
    expect(logServiceOf({ source: 'http', path: '/api/users' })).toBe('api');
  });

  it('files everything else by the subsystem that wrote it, and honours an explicit service', () => {
    expect(logServiceOf({ source: 'sql' })).toBe('postgres');
    expect(logServiceOf({ source: 'job' })).toBe('cron');
    expect(logServiceOf({ source: 'pooler' })).toBe('pooler');
    expect(logServiceOf({ source: 'console' })).toBe('platform');
    expect(logServiceOf({ source: 'webhook', service: 'auth' })).toBe('auth');
  });
});

describe('parseStatusFilter', () => {
  it('reads classes, exact codes and ranges, and refuses anything else', () => {
    expect(parseStatusFilter('5xx, 404,400-403')).toEqual([
      { min: 500, max: 599 },
      { min: 404, max: 404 },
      { min: 400, max: 403 },
    ]);
    expect(parseStatusFilter('50x')).toBeNull();
    expect(parseStatusFilter('')).toBeNull();
  });
});

describe('log filter', () => {
  const buffer = new LogBuffer(10);
  const request = buffer.push({ level: 'error', source: 'http', message: 'GET /rest/v1/todos → 503', method: 'GET', path: '/rest/v1/todos', status: 503, userId: 'u1' });
  const job = buffer.push({ level: 'info', source: 'job', message: '[job:backup] ok' });

  it('treats api as every request line, whatever service it reached', () => {
    expect(request.service).toBe('rest');
    expect(matchesLogFilter(request, { services: ['api'] })).toBe(true);
    expect(matchesLogFilter(job, { services: ['api'] })).toBe(false);
    expect(matchesLogFilter(job, { services: ['cron'] })).toBe(true);
  });

  it('matches status, path, method and user the same way the SQL filter asks for them', () => {
    const filter = { statuses: [{ min: 500, max: 599 }], path: 'TODOS', method: 'get', userId: 'u1' };
    expect(matchesLogFilter(request, filter)).toBe(true);
    expect(matchesLogFilter(request, { ...filter, userId: 'u2' })).toBe(false);
    expect(matchesLogFilter(job, filter)).toBe(false);
    expect(logFilterWhere(filter)).toEqual({
      AND: [
        { OR: [{ status: { gte: 500, lte: 599 } }] },
        { method: { equals: 'get', mode: 'insensitive' } },
        { path: { contains: 'TODOS', mode: 'insensitive' } },
        { userId: 'u1' },
      ],
    });
    expect(logFilterWhere({ services: ['api', 'cron'] })).toEqual({
      AND: [{ OR: [{ method: { not: null } }, { service: 'cron' }] }],
    });
  });
});

describe('log cursor', () => {
  const at = '2026-10-25T12:00:00.000Z';
  const line = (id: number, when = at) => ({ id, at: when, level: 'info' as const, source: 'job', service: 'cron' as const, message: '' });

  it('round-trips, and refuses anything it did not produce', () => {
    expect(parseLogCursor(logCursor(line(42)))).toEqual({ at: new Date(at), id: 42 });
    expect(parseLogCursor('42')).toBeNull();
    expect(parseLogCursor('abc:1')).toBeNull();
  });

  it('pages strictly older lines, splitting a millisecond by id', () => {
    const before = parseLogCursor(logCursor(line(10)))!;
    expect(matchesLogFilter(line(9), { before })).toBe(true);
    expect(matchesLogFilter(line(10), { before })).toBe(false);
    expect(matchesLogFilter(line(11), { before })).toBe(false);
    expect(matchesLogFilter(line(99, '2026-10-25T11:59:59.999Z'), { before })).toBe(true);
    expect(matchesLogFilter(line(1, '2026-10-25T12:00:00.001Z'), { before })).toBe(false);
    expect(logFilterWhere({ before })).toEqual({
      AND: [{ OR: [{ at: { lt: before.at } }, { at: before.at, id: { lt: 10 } }] }],
    });
  });
});
