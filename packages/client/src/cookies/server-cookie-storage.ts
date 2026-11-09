import { SessionStorageAdapter } from "../auth/types.js";
import { CookieMethods, SESSION_COOKIE_KEY } from "./types.js";
import { parseSession, warnSessionCookieUnwritable } from "./utils.js";

/**
 * Server-side cookie adapter built on batch `getAll`/`setAll` methods.
 * The shape Next.js's `cookies()` (Server Components/Route Handlers) and
 * `NextRequest.cookies`/`NextResponse.cookies` (middleware) already expose.
 *
 * `httpOnly` defaults to false, and that default is load-bearing: in the
 * standard SSR setup `createBrowserClient` reads this same cookie from
 * `document.cookie`, so hiding it from scripts signs the browser half out.
 * Turn it on only when the browser client keeps its own copy elsewhere
 * (`storage: localStorageStorage()`). Either way the cookie is unsigned, so
 * `client.hydrate()` (what the cookie holds) stays untrusted;
 * `auth.getSession()` asks the server and is the verified read.
 */
export function serverCookieStorage(
    cookies: CookieMethods,
    key = SESSION_COOKIE_KEY,
    options: { secure?: boolean; httpOnly?: boolean } = {},
): SessionStorageAdapter {
    const secure = options.secure ?? true;
    const httpOnly = options.httpOnly ?? false;
    return {
        get: () => {
            const match = cookies.getAll().find((c) => c.name === key);
            return parseSession(match?.value);
        },
        set: (session) => {
            if (!session) {
                try {
                    cookies.setAll([{ name: key, value: '', options: { path: '/', maxAge: 0 } }]);
                } catch {
                    // Signing out from a Server Component cannot clear the cookie either,
                    // but middleware will on the next navigation. Not worth a warning.
                }
                return;
            }
            try {
                cookies.setAll([
                    {
                        name: key,
                        // No percent-encoding here: `cookies().set()` encodes the value
                        // itself, and encoding first yields a double-encoded cookie the
                        // browser adapter can no longer parse.
                        value: JSON.stringify(session),
                        options: { path: '/', sameSite: 'lax', secure, httpOnly },
                    },
                ]);
            } catch (err) {
                warnSessionCookieUnwritable(err instanceof Error ? err.message : String(err));
                return;
            }
            // The adapter shape everyone copies wraps `setAll` in its own try/catch,
            // so a refused write does not reach the catch above. It just does
            // nothing. Reading it back is the only way to tell the difference.
            if (!cookies.getAll().some((c) => c.name === key && c.value !== '')) {
                warnSessionCookieUnwritable('the write was accepted but the cookie is not readable back');
            }
        },
    };
}