import type { MotherbaseError, MotherbaseResponse } from "../types.js";
import { BackendError } from "./backend-error.js";

/** Convert a thrown BackendError (or any error) into a Supabase-shaped error object. */
export function toError(err: unknown): MotherbaseError {
    if (err instanceof BackendError) {
        return {
            message: err.message,
            status: err.httpStatus || undefined,
            code: err.code,
            requestId: err.requestId,
        };
    }
    if (err instanceof Error) return { message: err.message };
    return { message: String(err) };
}

/**
 * Run a call and fold whatever it throws into the `{ data, error }` result the
 * public SDK promises. A thunk rather than a promise, so a synchronous throw
 * while building the request (a bad argument) is caught too.
 */
export async function settle<T>(call: () => Promise<T>): Promise<MotherbaseResponse<T>> {
    try {
        return { data: await call(), error: null };
    } catch (err) {
        return { data: null, error: toError(err) };
    }
}

/** `https://x.dev/` -> `https://x.dev`, so a path can be appended to any project URL. */
export function withoutTrailingSlash(url: string): string {
    return url.replace(/\/$/, '');
}

/** The backend sets `x-request-id` on every response; older ones may not. */
export function requestIdOf(res: Response): string | undefined {
    return res.headers?.get('x-request-id') ?? undefined;
}
