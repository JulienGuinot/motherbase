import type { MotherbaseResponse } from "../types.js";
import type { PostgrestQueryBuilder } from "./query-builder.js";

export type PostgrestPrimitive = string | number | boolean | null;

/** Value accepted by the array/range operators (`cs`, `cd`, `ov`). */
export type PostgrestArrayOperand =
    | string
    | readonly PostgrestPrimitive[]
    | Record<string, unknown>;

/** PostgREST's operator names. `filter()` also accepts modifier forms like `like(any)`. */
export type PostgrestFilterOperator =
    | 'eq'
    | 'neq'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'like'
    | 'ilike'
    | 'match'
    | 'imatch'
    | 'in'
    | 'is'
    | 'isdistinct'
    | 'fts'
    | 'plfts'
    | 'phfts'
    | 'wfts'
    | 'cs'
    | 'cd'
    | 'ov'
    | 'sl'
    | 'sr'
    | 'nxr'
    | 'nxl'
    | 'adj';

/** `is` reaches SQL NULL and the three-valued booleans, and nothing else. */
export type PostgrestIsValue = null | boolean | 'null' | 'true' | 'false' | 'unknown';

export type PostgrestCount = 'exact' | 'planned' | 'estimated';

export type TextSearchType = 'plain' | 'phrase' | 'websearch';

export interface ReferencedTableOption {
    /** Scope the modifier to an embedded resource: `comments.limit=5`. */
    referencedTable?: string;
    /** supabase-js's pre-2.x name for `referencedTable`. Accepted for parity. */
    foreignTable?: string;
}

export interface OrderOptions extends ReferencedTableOption {
    ascending?: boolean;
    nullsFirst?: boolean;
}

export interface PaginateOptions {
    /** Rows per request. Capped server side by `api.rest.maxRows`. Default 1000. */
    pageSize?: number;
}

export interface SelectOptions {
    count?: PostgrestCount;
    /** Send the request as HEAD: no rows come back, only the count. */
    head?: boolean;
}

export interface InsertOptions {
    count?: PostgrestCount;
    /**
     * `false` sends `Prefer: missing=default`, so columns absent from a row take
     * their column default instead of NULL.
     */
    defaultToNull?: boolean;
}

export interface UpsertOptions extends InsertOptions {
    /** Conflict target, defaulting server side to the primary key. */
    onConflict?: string;
    /** `true` sends `Prefer: resolution=ignore-duplicates`. */
    ignoreDuplicates?: boolean;
}

export interface MutateOptions {
    count?: PostgrestCount;
}

/** Options for `client.rpc(fn, args, options)`, mirroring supabase-js. */
export interface RpcOptions {
    /** Send the request as HEAD: no rows, only the count. */
    head?: boolean;
    /** Use the read-only GET form, with the arguments as query parameters. */
    get?: boolean;
    count?: PostgrestCount;
}

export interface ExplainOptions {
    analyze?: boolean;
    verbose?: boolean;
    settings?: boolean;
    buffers?: boolean;
    wal?: boolean;
    format?: 'text' | 'json';
}

/**
 * The result a query resolves to. `count` is `null` unless `{ count }` was
 * requested and the server answered with a `Content-Range` total.
 */
export interface PostgrestResponse<T> extends MotherbaseResponse<T> {
    count: number | null;
}

export type RowMode = 'many' | 'single' | 'maybeSingle';
export type ResponseKind = 'json' | 'text' | 'text-json';

/** Same builder, typed to resolve a single row (from `.single()` / `.maybeSingle()`). */
export interface PostgrestSingleBuilder<Row extends object>
    extends Omit<PostgrestQueryBuilder<Row>, 'then' | 'single' | 'maybeSingle' | 'returns'>,
    PromiseLike<PostgrestResponse<Row>> {
    returns<T extends object>(): PostgrestSingleBuilder<T>;
    then<TResult1 = PostgrestResponse<Row>, TResult2 = never>(
        onfulfilled?: ((value: PostgrestResponse<Row>) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2>;
}

/** The builder after `.csv()`: the body is text, not rows. */
export interface PostgrestTextBuilder extends PromiseLike<PostgrestResponse<string>> {
    toPath(): string;
    toHeaders(): Record<string, string>;
}

/** The builder after `.explain()`: text, or the parsed plan for `format: 'json'`. */
export interface PostgrestExplainBuilder extends PromiseLike<PostgrestResponse<unknown>> {
    toPath(): string;
    toHeaders(): Record<string, string>;
}
