import { contractPath } from '@motherbase/contracts';
import type { HttpClient } from '../http/index.js';
import { toError } from '../http/utils.js';
import type { PostgrestResponse, RpcOptions } from './types.js';
import { parseContentRange } from './utils.js';

/**
 * The one `/rpc/` transport, for `rpc()` and for every `schema(name).rpc()`.
 *
 * A schema other than `public` rides in the profile header PostgREST defines:
 * `Content-Profile` when there is a body, `Accept-Profile` on GET and HEAD.
 * The server serves only the schemas a feature has exposed and answers any
 * other with PGRST106, so nothing here needs to know which ones those are.
 */
export async function callRpc<Result>(
    http: HttpClient,
    schema: string,
    fn: string,
    args: unknown,
    options: RpcOptions,
): Promise<PostgrestResponse<Result>> {
    try {
        const method = options.head ? 'HEAD' : options.get ? 'GET' : 'POST';
        const params = new URLSearchParams();
        if (method !== 'POST') {
            for (const [name, value] of Object.entries((args ?? {}) as Record<string, unknown>)) {
                if (value === undefined) continue;
                params.append(name, Array.isArray(value) ? `{${value.join(',')}}` : String(value));
            }
        }
        const query = params.toString();
        const path = `${contractPath.rest('rpc')}/${encodeURIComponent(fn)}${query ? `?${query}` : ''}`;
        const headers: Record<string, string> = {};
        if (options.count) headers.Prefer = `count=${options.count}`;
        if (schema !== 'public') headers[method === 'POST' ? 'Content-Profile' : 'Accept-Profile'] = schema;

        const result = await http.requestWithHeaders<Result>(path, {
            method,
            body: method === 'POST' ? (args ?? {}) : undefined,
            headers,
        });
        const count = parseContentRange(result.headers.get('content-range'));
        return { data: options.head ? null : result.data, error: null, count };
    } catch (err) {
        return { data: null, error: toError(err), count: null };
    }
}
