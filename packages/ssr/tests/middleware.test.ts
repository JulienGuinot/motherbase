import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { updateSession } from '../src/middleware.js';

function sessionCookieValue(accessToken: string, email: string): string {
  return encodeURIComponent(JSON.stringify({ accessToken, user: { id: 'u1', email } }));
}

describe('updateSession', () => {
  it('revalidates the session, writes back what changed and passes the request through', async () => {
    const request = new NextRequest('http://app.test/dashboard', {
      headers: { cookie: `motherbase.session=${sessionCookieValue('tok1', 'a@test.dev')}` },
    });

    // The email changed on the server since the cookie was written.
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ session: { token: 'tok1' }, user: { id: 'u1', email: 'b@test.dev' } }), { status: 200 });

    const response = await updateSession(request, 'http://localhost:5001', undefined, { fetch: fetchMock });

    expect(response.headers.get('x-middleware-next') ?? response.status).toBeTruthy();
    const setCookie = response.cookies.get('motherbase.session');
    expect(decodeURIComponent(setCookie?.value ?? '')).toContain('b@test.dev');
  });

  it('clears the cookie when the backend rejects the session', async () => {
    const request = new NextRequest('http://app.test/dashboard', {
      headers: { cookie: `motherbase.session=${sessionCookieValue('tok1', 'a@test.dev')}` },
    });

    // Better Auth answers get-session for an unknown token with null, not a 401.
    const fetchMock: typeof fetch = async () => new Response('null', { status: 200 });

    const response = await updateSession(request, 'http://localhost:5001', undefined, { fetch: fetchMock });

    expect(response.cookies.get('motherbase.session')?.value).toBe('');
  });

  it('does not throw and passes the request through when the backend is unreachable', async () => {
    const request = new NextRequest('http://app.test/dashboard', {
      headers: { cookie: `motherbase.session=${sessionCookieValue('tok1', 'a@test.dev')}` },
    });

    const fetchMock: typeof fetch = async () => {
      throw new Error('network down');
    };

    const response = await updateSession(request, 'http://localhost:5001', undefined, { fetch: fetchMock });
    expect(response).toBeTruthy();
  });
});
