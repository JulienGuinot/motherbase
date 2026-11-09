export interface RequestOptions {
    method?: string;
    /** Headers scoped to this request. Override client-level headers. */
    headers?: Record<string, string>;
    /** JSON body. Mutually exclusive with `form`. */
    body?: unknown;
    /** Multipart body. Mutually exclusive with `body`. */
    form?: FormData;
    /** Skip attaching the Authorization header (used by auth endpoints). */
    anonymous?: boolean;
    /** Abort the request when this signal fires (`.abortSignal(signal)`). */
    signal?: AbortSignal;
    /**
     * Parse the response body as-is instead of unwrapping the app's
     * `{ status, data }` envelope. Better Auth's native /api/auth/* endpoints
     * return plain JSON, so the auth client sets this.
     */
    raw?: boolean;
    /**
     * Cookie mode for this request. Defaults to fetch's own `same-origin`.
     * OAuth start endpoints need `'include'`: better-auth sets a signed state
     * cookie on that response and verifies it on the provider callback, and a
     * cross-origin response's cookie is discarded without it (the callback then
     * fails with `state_mismatch`).
     */
    credentials?: RequestCredentials;
    /** Internal: prevents infinite refresh recursion. */
    _retry?: boolean;
}

/** What every request reports to `client.on('request', ...)`. */
export interface RequestEvent {
    method: string;
    /** Path with query string, as sent. */
    path: string;
    /** HTTP status, or 0 when the request never completed (network, abort). */
    status: number;
    /** Wall time from send to response headers, in milliseconds. */
    durationMs: number;
    /** `x-request-id`, the id to quote when reporting a server-side failure. */
    requestId?: string;
    /** Set when the request failed outright rather than answering. */
    error?: unknown;
}

export type RequestObserver = (event: RequestEvent) => void;