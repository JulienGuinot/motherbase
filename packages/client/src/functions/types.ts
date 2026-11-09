export type FunctionInvokeAuth =
    | { type: 'edge-token'; token: string }
    | { type: 'public' };

export interface FunctionInvokeOptions<Body = unknown> {
    /** JSON body passed to the edge function. */
    body?: Body;
    /**
     * Authentication override. By default the current session bearer is used.
     * Public and dedicated Edge-token invocations must be explicitly selected.
     */
    auth?: FunctionInvokeAuth;
    /** HTTP method the function receives. Defaults to POST, as in supabase-js. */
    method?: 'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE';
    /** Extra request headers, forwarded to the function. */
    headers?: Record<string, string>;
    /**
     * Accepted for supabase-js signature parity and ignored: a self-hosted
     * Motherbase runs its functions in one place, so there is no region to pick.
     */
    region?: string;
}
