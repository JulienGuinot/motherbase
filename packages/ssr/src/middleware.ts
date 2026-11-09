import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { CookieToSet } from '@motherbase/client';
import { createServerClient } from './server.js';

/**
 * Call on every navigation, from `proxy.ts` (Next.js 16+, where the
 * `middleware.ts` convention is deprecated and warns at build time) or from
 * `middleware.ts` (Next.js 14 and 15). Both files export the same
 * `middleware`/`proxy` function shape, and this helper is identical in either.
 *
 * ```ts
 * // proxy.ts
 * import { updateSession } from '@motherbase/ssr'
 *
 * export async function proxy(request: NextRequest) {
 *   return updateSession(request, process.env.NEXT_PUBLIC_MOTHERBASE_URL!, key)
 * }
 * ```
 *
 * This is not optional plumbing: it is the only place the session cookie can
 * actually be written. Server Components cannot set cookies, so without this
 * the cookie is never refreshed, no Authorization header is ever attached, and
 * `auth.getSession()` returns null on both the server and the client.
 *
 * Revalidates the session against the backend with `auth.getSession()`. A
 * session the server no longer knows is cleared through the store, which is
 * what removes it from the response cookie.
 *
 * Never throws: a network failure leaves the existing cookie/session in
 * place and the request proceeds.
 *
 * Whatever it writes, the cookie stays unsigned: authorize on the user
 * `auth.getSession()` returns, never on the cookie's contents. `httpOnly` is
 * available here but breaks `createBrowserClient` unless that client is given
 * its own storage; see `SsrOptions.httpOnly`.
 */
export async function updateSession(
  request: NextRequest,
  url: string,
  key?: string,
  options: { fetch?: typeof fetch; cookieKey?: string; httpOnly?: boolean } = {},
): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const client = createServerClient(url, key, {
    fetch: options.fetch,
    cookieKey: options.cookieKey,
    httpOnly: options.httpOnly,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookies: CookieToSet[]) => {
        for (const { name, value } of cookies) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options: cookieOptions } of cookies) {
          response.cookies.set(name, value, cookieOptions);
        }
      },
    },
  });

  try {
    await client.auth.getSession();
  } catch {
    // Backend unreachable: keep the existing session, don't break navigation.
  }

  return response;
}
