import { describe, it, expect, vi } from 'vitest';
import { createClient } from '../src/index.js';
import { memoryStorage } from '../src/auth/session.js';

/**
 * `client.schema(name).rpc()`: the schema travels in PostgREST's profile
 * headers, and a bare `rpc()` sends none. Which schemas exist is the server's
 * call (it answers PGRST106 for the rest), asserted by the queues suite.
 */

function client() {
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
  const impl = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify([7]), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const c = createClient('http://api.test', undefined, { storage: memoryStorage(), fetch: impl as unknown as typeof fetch });
  return { c, calls };
}

describe('client.schema(name).rpc', () => {
  it('sends Content-Profile on a POST call', async () => {
    const { c, calls } = client();
    const { data, error } = await c.schema('pgmq_public').rpc('send', { queue_name: 'jobs', message: { a: 1 } });

    expect(error).toBeNull();
    expect(data).toEqual([7]);
    expect(calls[0].url).toBe('http://api.test/rest/v1/rpc/send');
    expect(calls[0].headers.get('content-profile')).toBe('pgmq_public');
    expect(calls[0].headers.get('accept-profile')).toBeNull();
    expect(calls[0].body).toEqual({ queue_name: 'jobs', message: { a: 1 } });
  });

  it('sends Accept-Profile on the GET form', async () => {
    const { c, calls } = client();
    await c.schema('reporting').rpc('totals', { year: 2026 }, { get: true });

    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers.get('accept-profile')).toBe('reporting');
    expect(calls[0].headers.get('content-profile')).toBeNull();
  });

  it('sends no profile for public, and schema(public) is the client itself', async () => {
    const { c, calls } = client();
    expect(c.schema('public')).toBe(c);
    await c.rpc('anything');
    expect(calls[0].headers.get('content-profile')).toBeNull();
  });

  it('refuses tables outside public before any request', () => {
    const { c, calls } = client();
    expect(() => c.schema('pgmq_public').from('q_jobs')).toThrow(/public schema only/);
    expect(calls).toHaveLength(0);
  });
});
