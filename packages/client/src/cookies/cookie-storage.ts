import { memoryStorage } from "../auth/session.js";
import { SessionStorageAdapter } from "../auth/types.js";
import { SESSION_COOKIE_KEY } from "./types.js";
import { escapeRegex, parseSession, serializeSession } from "./utils.js";

/**
 * Browser cookie adapter. Falls back to in-memory storage when
 * `document` is not available (SSR, Node.js environments).
 */
export function cookieStorage(options: {
    key?: string;
    path?: string;
    secure?: boolean;
    sameSite?: 'lax' | 'strict' | 'none';
} = {}): SessionStorageAdapter {
    const doc =
        typeof document !== 'undefined' ? document : undefined;
    if (!doc) return memoryStorage();

    const key = options.key ?? SESSION_COOKIE_KEY;
    const path = options.path ?? '/';
    const secure = options.secure ?? true;
    const sameSite = options.sameSite ?? 'lax';
    const pattern = new RegExp(`(?:^|; )${escapeRegex(key)}=([^;]*)`);

    return {
        get: () => {
            const match = doc.cookie.match(pattern);
            return parseSession(match?.[1]);
        },
        set: (session) => {
            if (session) {
                let cookie = `${key}=${serializeSession(session)}; path=${path}; SameSite=${sameSite}`;
                if (secure) cookie += '; Secure';
                doc.cookie = cookie;
            } else {
                doc.cookie = `${key}=; path=${path}; max-age=0`;
            }
        },
    };
}