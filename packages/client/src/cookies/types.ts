import { SESSION_COOKIE_KEY } from '../auth/session.js';

export interface CookieOptions {
    path?: string;
    maxAge?: number;
    secure?: boolean;
    sameSite?: 'lax' | 'strict' | 'none';
    httpOnly?: boolean;
    domain?: string;
}

/** A single cookie to write, as returned by `document.cookie`/`next/headers` style APIs. */
export interface CookieToSet {
    name: string;
    value: string;
    options?: CookieOptions;
}

/**
 * Batch cookie read/write, matching the shape Next.js's `cookies()` and
 * `NextRequest.cookies`/`NextResponse.cookies` already provide.
 */
export interface CookieMethods {
    getAll(): { name: string; value: string }[];
    setAll(cookies: CookieToSet[]): void;
}

/**
 * The cookie the session is stored in. Re-exported here because both halves of
 * an SSR setup have to agree on it: the browser writes it, the server reads it,
 * and a key that matches on only one side looks exactly like "logged out".
 */
export { SESSION_COOKIE_KEY };
