import { describe, it, expect, vi } from 'vitest';
import { createTestClient, IMPERSONATE_HEADER } from '../src/utils/testing.js';

/**
 * The header is the whole contract: the server decides what it means, and
 * refuses it for anything but a secret key. What is worth pinning here is that
 * the client sends it for a user and for `anon`, does not send it for
 * `service_role`, and refuses a key that cannot possibly work.
 */

function capture() {
  const calls: Array<Record<string, string>> = [];
  const impl = vi.fn(async (_url: string | URL, init: RequestInit = {}) => {
    calls.push((init.headers ?? {}) as Record<string, string>);
    return new Response(JSON.stringify({ status: 1, data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('createTestClient', () => {
  it('sends the impersonation header for a user id', async () => {
    const { impl, calls } = capture();
    const client = createTestClient('http://api.test', 'mb_secret_x', { as: 'user-1', fetch: impl });
    await client.from<{ id: string }>('t').select('*');

    expect(calls[0][IMPERSONATE_HEADER]).toBe('user-1');
    expect(calls[0]['apikey']).toBe('mb_secret_x');
  });

  it('sends anon as a caller of nobody', async () => {
    const { impl, calls } = capture();
    const client = createTestClient('http://api.test', 'mb_secret_x', { as: 'anon', fetch: impl });
    await client.from<{ id: string }>('t').select('*');

    expect(calls[0][IMPERSONATE_HEADER]).toBe('anon');
  });

  it('sends no header for service_role, which the secret key already is', async () => {
    const { impl, calls } = capture();
    const client = createTestClient('http://api.test', 'mb_secret_x', { as: 'service_role', fetch: impl });
    await client.from<{ id: string }>('t').select('*');

    expect(calls[0][IMPERSONATE_HEADER]).toBeUndefined();
  });

  it('refuses a publishable key up front rather than at the first query', () => {
    expect(() => createTestClient('http://api.test', 'mb_publishable_x', { as: 'user-1' })).toThrow(
      /secret key/,
    );
  });
});
