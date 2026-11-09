import { contractPath } from "@motherbase/contracts";
import { HttpClient } from "../http/index.js";
import { BackendError, FunctionInvokeOptions, FunctionsFetchError, FunctionsHttpError, MotherbaseResponse } from "../index.js";
import { warnIgnoredOption } from "../utils/warn.js";
import { toError } from "../http/utils.js";
import type { EdgeFunctionName, GenericDatabase } from "../database/types.js";

/** Supabase-compatible edge functions client: `client.functions.invoke(name, { body })`. */
export class FunctionsClient<Database = GenericDatabase> {
    constructor(private readonly http: HttpClient) { }

    async invoke<Result = unknown, Body = Record<string, unknown>>(
        name: EdgeFunctionName<Database>,
        options: FunctionInvokeOptions<Body> = {},
    ): Promise<MotherbaseResponse<Result>> {
        try {
            if (options.region) {
                warnIgnoredOption(
                    'functions.invoke',
                    'region',
                    'A self-hosted Motherbase runs every function in one place, so the call goes there regardless.',
                );
            }
            const edgeToken = options.auth?.type === 'edge-token' ? options.auth.token : undefined;
            const method = options.method ?? 'POST';
            const data = await this.http.request<Result>(contractPath.edge(name), {
                method,
                // A GET or DELETE with a JSON body is refused by some proxies and means
                // nothing to the function, so the body is only sent where it can be read.
                body: method === 'GET' || method === 'DELETE' ? undefined : (options.body ?? {}),
                anonymous: options.auth !== undefined,
                headers: {
                    ...options.headers,
                    ...(edgeToken ? { 'x-motherbase-edge-token': edgeToken } : {}),
                },
            });
            return { data, error: null };
        } catch (err) {
            const base = toError(err);
            const status = err instanceof BackendError ? err.httpStatus : 0;
            const error = status
                ? Object.assign(new FunctionsHttpError(base.message, status), base)
                : Object.assign(new FunctionsFetchError(base.message), base);
            return { data: null, error };
        }
    }
}
