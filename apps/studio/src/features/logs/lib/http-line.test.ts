import { describe, expect, it } from 'vitest';
import { durationColor, parseHttpLine, statusColor } from '@/features/logs/lib/http-line';

describe('parseHttpLine', () => {
  it('reads back exactly what request-logger.ts writes', () => {
    expect(parseHttpLine('POST /api/users → 201 (128ms) [req-abc]')).toEqual({
      method: 'POST',
      path: '/api/users',
      status: 201,
      ms: 128,
      requestId: 'req-abc',
    });
  });

  it('accepts a line with no request id', () => {
    expect(parseHttpLine('GET /api/health → 200 (3ms)')).toEqual({
      method: 'GET',
      path: '/api/health',
      status: 200,
      ms: 3,
      requestId: undefined,
    });
  });

  it('reads a 3xx line with its redirect target and request id', () => {
    const line =
      'GET /api/auth/callback/google?state=abc&code=xyz789 → 302 (924ms) ⇢ https://app.acme.test/auth/callback [0b6f1c2e-5d7a-4e3b-9c1f-2a8d4e6b7c90]';
    expect(parseHttpLine(line)).toEqual({
      method: 'GET',
      path: '/api/auth/callback/google?state=abc&code=xyz789',
      status: 302,
      ms: 924,
      redirect: 'https://app.acme.test/auth/callback',
      requestId: '0b6f1c2e-5d7a-4e3b-9c1f-2a8d4e6b7c90',
    });
  });

  it('accepts a redirect line with no request id', () => {
    expect(parseHttpLine('GET /old → 301 (2ms) ⇢ /new')).toEqual({
      method: 'GET',
      path: '/old',
      status: 301,
      ms: 2,
      redirect: '/new',
      requestId: undefined,
    });
  });

  it('returns null for anything that is not an HTTP line', () => {
    // These fall through to the plain-message renderer.
    expect(parseHttpLine('SELECT * FROM users')).toBeNull();
    expect(parseHttpLine('GET /api/users -> 200 (3ms)')).toBeNull();
    expect(parseHttpLine('')).toBeNull();
  });

  it('grades status and duration by class', () => {
    expect(statusColor(204)).toBe('var(--green)');
    expect(statusColor(302)).toBe('var(--blue)');
    expect(statusColor(404)).toBe('var(--amber)');
    expect(statusColor(500)).toBe('var(--red)');
    expect(durationColor(50)).toBe('var(--text-mute)');
    expect(durationColor(500)).toBe('var(--amber)');
    expect(durationColor(1500)).toBe('var(--red)');
  });
});
