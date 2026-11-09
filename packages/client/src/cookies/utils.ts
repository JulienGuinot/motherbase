import { Session } from "../auth/types.js";


let warnedAboutCookieWrite = false;

/** Browsers drop a cookie past ~4096 bytes, silently signing the user out. */
const COOKIE_WARN_LENGTH = 3800;
let warnedAboutCookieSize = false;

/**
 * `process` is not declared in this package's lib (it targets the browser), so
 * read it off `globalThis` rather than pulling in @types/node for one check.
 * @internal
 */
export function isProduction(): boolean {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    return proc?.env?.NODE_ENV === 'production';
}

/**
 * The single most expensive failure in an SSR setup is silent: the session
 * cookie is never written, so `auth.getSession()` returns null everywhere
 * and no Authorization header is ever attached, with nothing in the logs.
 *
 * It happens because Next.js forbids writing cookies from a Server Component,
 * and the documented adapter shape swallows that failure in its own try/catch.
 * The cookie has to be written from middleware instead, which is what
 * `updateSession` from `@motherbase/ssr` is for. Say so, once, in development.
 */
export function warnSessionCookieUnwritable(reason: string): void {
    if (warnedAboutCookieWrite) return;
    if (isProduction()) return;
    warnedAboutCookieWrite = true;
    console.warn(
        `[motherbase] The session cookie could not be written (${reason}). Server Components cannot `
        + 'set cookies, so the session has to be refreshed in middleware: call `updateSession` from '
        + '`@motherbase/ssr` in `proxy.ts` (Next.js 16+) or `middleware.ts` (Next.js 14/15). Until '
        + 'then auth.getSession() returns null on every request.',
    );
}

export function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @internal exported for tests; not part of the package's public surface. */
export function parseSession(raw: string | undefined): Session | null {
    if (!raw) return null;
    // Server adapters (Next's `cookies()`) hand back an already-decoded value;
    // `document.cookie` hands back the percent-encoded one. Try both.
    try {
        return JSON.parse(raw) as Session;
    } catch {
        /* not plain JSON: fall through */
    }
    try {
        return JSON.parse(decodeURIComponent(raw)) as Session;
    } catch {
        return null;
    }
}



export function serializeSession(session: Session): string {
    const value = encodeURIComponent(JSON.stringify(session));
    if (!warnedAboutCookieSize && value.length > COOKIE_WARN_LENGTH && !isProduction()) {
        warnedAboutCookieSize = true;
        console.warn(
            `[motherbase] The serialized session is ${value.length} characters, close to the ~4096 byte `
            + 'browser cookie limit. An oversized cookie is dropped silently and the user appears signed '
            + 'out. Trim custom user metadata, or use `localStorageStorage()` for the browser client.',
        );
    }
    return value;
}