import { describe, it, expect } from 'vitest';
import { createServerClient } from '../src/server.js';
import type { CookieMethods, CookieToSet } from '@motherbase/client';

function fakeCookieJar(): CookieMethods & { jar: Map<string, string> } {
  const jar = new Map<string, string>();
  return {
    jar,
    getAll: () => Array.from(jar.entries()).map(([name, value]) => ({ name, value })),
    setAll: (cookies: CookieToSet[]) => {
      for (const c of cookies) {
        if (c.options?.maxAge === 0) jar.delete(c.name);
        else jar.set(c.name, c.value);
      }
    },
  };
}

describe('createServerClient', () => {
  it('reads a pre-existing session from the supplied cookie jar', async () => {
    const jar = fakeCookieJar();
    jar.jar.set(
      'motherbase.session',
      encodeURIComponent(JSON.stringify({ accessToken: 'tok1', user: { id: 'u1', email: 'a@test.dev' } })),
    );

    const client = createServerClient('http://localhost:5001', undefined, { cookies: jar });
    expect((await client.hydrate())?.accessToken).toBe('tok1');
  });

  it('writes the session back through setAll on sign-out', async () => {
    const jar = fakeCookieJar();
    jar.jar.set(
      'motherbase.session',
      encodeURIComponent(JSON.stringify({ accessToken: 'tok1', user: { id: 'u1', email: 'a@test.dev' } })),
    );

    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({}), { status: 200 });

    const client = createServerClient('http://localhost:5001', undefined, { cookies: jar, fetch: fetchMock });
    await client.auth.signOut();

    expect(jar.jar.has('motherbase.session')).toBe(false);
  });

  it('sends the Authorization header on the from()/postgrest path without any prior auth.* call', async () => {
    const jar = fakeCookieJar();
    jar.jar.set(
      'motherbase.session',
      encodeURIComponent(JSON.stringify({ accessToken: 'tok1', user: { id: 'u1', email: 'a@test.dev' } })),
    );

    let capturedAuthHeader: string | null = null;
    const fetchMock: typeof fetch = async (_input, init) => {
      capturedAuthHeader = (init?.headers as Record<string, string>)?.['Authorization'] ?? null;
      return new Response(JSON.stringify({ status: 1, data: [] }), { status: 200 });
    };

    const client = createServerClient('http://localhost:5001', undefined, { cookies: jar, fetch: fetchMock });
    await client.from('todo').select('*');

    expect(capturedAuthHeader).toBe('Bearer tok1');
  });

  it('never mints an access JWT: the client is gone before one could be used', async () => {
    const jar = fakeCookieJar();
    jar.jar.set(
      'motherbase.session',
      encodeURIComponent(JSON.stringify({ accessToken: 'tok1', user: { id: 'u1', email: 'a@test.dev' } })),
    );

    const paths: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      paths.push(new URL(String(input)).pathname);
      return new Response(JSON.stringify({ status: 1, data: [] }), { status: 200 });
    };

    const client = createServerClient('http://localhost:5001', undefined, { cookies: jar, fetch: fetchMock });
    await client.from('todo').select('*');
    await client.from('todo').select('*');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(paths).toEqual(['/rest/v1/todo', '/rest/v1/todo']);
  });
});
