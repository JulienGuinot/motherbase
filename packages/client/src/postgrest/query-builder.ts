import { contractPath } from "@motherbase/contracts";
import { HttpClient } from "../http/index.js";
import { MotherbaseError } from "../types.js";
import type {
    ExplainOptions,
    InsertOptions,
    MutateOptions,
    OrderOptions,
    PaginateOptions,
    PostgrestArrayOperand,
    PostgrestCount,
    PostgrestExplainBuilder,
    PostgrestFilterOperator,
    PostgrestIsValue,
    PostgrestPrimitive,
    PostgrestResponse,
    PostgrestSingleBuilder,
    PostgrestTextBuilder,
    ReferencedTableOption,
    ResponseKind,
    RowMode,
    SelectOptions,
    TextSearchType,
    UpsertOptions,
} from "./types.js";
import {
    encodeArrayLiteral,
    encodeArrayOperand,
    encodeList,
    encodeLiteral,
    encodeRawOperand,
    isValueOf,
    parseContentRange,
    referenced,
    safeJson,
    scopedKey,
} from "./utils.js";
import { toError } from "../http/utils.js";

export class PostgrestQueryBuilder<Row extends object = Record<string, unknown>>
    implements PromiseLike<PostgrestResponse<Row[]>> {
    private method: 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'DELETE' = 'GET';
    private columns = '*';
    /**
     * Repeated filters on one column must all survive: `?price=gt.10&price=lt.20`
     * is two conditions ANDed together, which is why every filter is `append`ed
     * and never `set`. Using `set` here (as this builder once did) silently
     * dropped the first of the two.
     */
    private readonly filters = new URLSearchParams();
    /** Reserved params that are replaced rather than repeated (`columns`, `on_conflict`). */
    private readonly extras = new Map<string, string>();
    /** Keyed by referenced table (`''` for the base relation). */
    private readonly orderParts = new Map<string, string[]>();
    private readonly limits = new Map<string, number>();
    private readonly offsets = new Map<string, number>();
    private readonly prefer: string[] = [];
    private accept?: string;
    private responseKind: ResponseKind = 'json';
    private countOption?: PostgrestCount;
    private headOnly = false;
    private signal?: AbortSignal;
    private readonly extraHeaders: Record<string, string> = {};
    private body?: unknown;
    private rowMode: RowMode = 'many';
    private shouldThrow = false;
    /** Set by `select()`, so a write can tell "rows asked for" from "no rows requested". */
    private selectCalled = false;

    constructor(
        private readonly http: HttpClient,
        private readonly model: string,
        /** supabase-js semantic parity, from `createClient(..., { compat: 'supabase' })`. */
        private readonly compat = false,
        /** Batch builders describe writes; they cannot send individual requests. */
        private readonly transactionOnly = false,
    ) { }

    // --- verbs -------------------------------------------------------------

    /**
     * Choose the columns, and optionally ask for a row count.
     *
     * After a write, `.select()` is the supabase-js way of asking for the rows
     * back, so it also sends `Prefer: return=representation`.
     */
    select(columns = '*', options: SelectOptions = {}): this {
        this.columns = columns;
        this.selectCalled = true;
        if (options.count) this.countOption = options.count;
        if (options.head) {
            this.headOnly = true;
            if (this.method === 'GET') this.method = 'HEAD';
        }
        return this;
    }

    insert(values: Partial<Row> | Array<Partial<Row>>, options: InsertOptions = {}): this {
        this.method = 'POST';
        this.body = values;
        this.applyColumns(values);
        if (options.count) this.countOption = options.count;
        if (options.defaultToNull === false) this.prefer.push('missing=default');
        return this;
    }

    /**
     * `INSERT .. ON CONFLICT DO UPDATE`. The conflict target defaults to the
     * primary key server side; `onConflict` names another unique constraint.
     */
    upsert(values: Partial<Row> | Array<Partial<Row>>, options: UpsertOptions = {}): this {
        this.method = 'POST';
        this.body = values;
        this.applyColumns(values);
        this.prefer.push(`resolution=${options.ignoreDuplicates ? 'ignore' : 'merge'}-duplicates`);
        if (options.onConflict !== undefined) this.extras.set('on_conflict', options.onConflict);
        if (options.count) this.countOption = options.count;
        if (options.defaultToNull === false) this.prefer.push('missing=default');
        return this;
    }

    update(values: Partial<Row>, options: MutateOptions = {}): this {
        this.method = 'PATCH';
        this.body = values;
        if (options.count) this.countOption = options.count;
        return this;
    }

    delete(options: MutateOptions = {}): this {
        this.method = 'DELETE';
        if (options.count) this.countOption = options.count;
        return this;
    }

    /**
     * A bulk write states its column set explicitly, so a key missing from one
     * row is still written (as NULL, or as the column default under
     * `missing=default`) instead of being inferred from the first row alone.
     */
    private applyColumns(values: unknown): void {
        if (!Array.isArray(values)) return;
        const seen = new Set<string>();
        for (const row of values) {
            if (row && typeof row === 'object') for (const key of Object.keys(row)) seen.add(key);
        }
        if (seen.size) {
            this.extras.set('columns', Array.from(seen, column => `"${column}"`).join(','));
        }
    }

    // --- filters -----------------------------------------------------------

    eq(column: string, value: PostgrestPrimitive): this {
        return this.push(column, `eq.${encodeLiteral(value)}`);
    }
    neq(column: string, value: PostgrestPrimitive): this {
        return this.push(column, `neq.${encodeLiteral(value)}`);
    }
    gt(column: string, value: PostgrestPrimitive): this {
        return this.push(column, `gt.${encodeLiteral(value)}`);
    }
    gte(column: string, value: PostgrestPrimitive): this {
        return this.push(column, `gte.${encodeLiteral(value)}`);
    }
    lt(column: string, value: PostgrestPrimitive): this {
        return this.push(column, `lt.${encodeLiteral(value)}`);
    }
    lte(column: string, value: PostgrestPrimitive): this {
        return this.push(column, `lte.${encodeLiteral(value)}`);
    }
    /** Case-sensitive LIKE. `*` is PostgREST's URL-friendly `%`. */
    like(column: string, pattern: string): this {
        return this.push(column, `like.${encodeLiteral(pattern)}`);
    }
    ilike(column: string, pattern: string): this {
        return this.push(column, `ilike.${encodeLiteral(pattern)}`);
    }
    likeAllOf(column: string, patterns: readonly string[]): this {
        return this.push(column, `like(all).${encodeArrayLiteral(patterns)}`);
    }
    likeAnyOf(column: string, patterns: readonly string[]): this {
        return this.push(column, `like(any).${encodeArrayLiteral(patterns)}`);
    }
    ilikeAllOf(column: string, patterns: readonly string[]): this {
        return this.push(column, `ilike(all).${encodeArrayLiteral(patterns)}`);
    }
    ilikeAnyOf(column: string, patterns: readonly string[]): this {
        return this.push(column, `ilike(any).${encodeArrayLiteral(patterns)}`);
    }
    in(column: string, values: readonly PostgrestPrimitive[]): this {
        return this.push(column, `in.${encodeList(values)}`);
    }
    is(column: string, value: PostgrestIsValue): this {
        return this.push(column, `is.${isValueOf(value)}`);
    }
    /** Every key equal to its value, ANDed together. */
    match(query: Record<string, PostgrestPrimitive>): this {
        for (const [column, value] of Object.entries(query)) this.eq(column, value);
        return this;
    }

    /**
     * Negate any operator: `not('status', 'eq', 'live')` emits
     * `status=not.eq.live`. The value is passed through verbatim for a string, so
     * composite operands (`not('id', 'in', '(1,2)')`) reach the server as written.
     */
    not(
        column: string,
        operator: PostgrestFilterOperator | (string & {}),
        value: PostgrestPrimitive | readonly PostgrestPrimitive[],
    ): this {
        return this.push(column, `not.${operator}.${encodeRawOperand(value)}`);
    }

    /**
     * The escape hatch: any operator, including the ones with no dedicated method
     * (`match`, `imatch`, `isdistinct`) and the modifier forms (`like(any)`).
     */
    filter(
        column: string,
        operator: PostgrestFilterOperator | (string & {}),
        value: PostgrestPrimitive | readonly PostgrestPrimitive[],
    ): this {
        return this.push(column, `${operator}.${encodeRawOperand(value)}`);
    }

    /**
     * A disjunction, written in PostgREST's own syntax and nestable:
     * `or('status.eq.live,and(price.gt.10,price.lt.20)')`.
     */
    or(filters: string, options: ReferencedTableOption = {}): this {
        return this.push(scopedKey(referenced(options), 'or'), `(${filters})`);
    }

    /** Full-text search. `type` picks the tsquery parser, `config` the dictionary. */
    textSearch(
        column: string,
        query: string,
        options: { type?: TextSearchType; config?: string } = {},
    ): this {
        const prefix =
            options.type === 'plain'
                ? 'pl'
                : options.type === 'phrase'
                    ? 'ph'
                    : options.type === 'websearch'
                        ? 'w'
                        : '';
        const config = options.config === undefined ? '' : `(${options.config})`;
        return this.push(column, `${prefix}fts${config}.${encodeLiteral(query)}`);
    }

    /** `@>`: the column contains the operand (array, range or jsonb). */
    contains(column: string, value: PostgrestArrayOperand): this {
        return this.push(column, `cs.${encodeArrayOperand(value)}`);
    }
    /** `<@`: the column is contained by the operand. */
    containedBy(column: string, value: PostgrestArrayOperand): this {
        return this.push(column, `cd.${encodeArrayOperand(value)}`);
    }
    /** `&&`: the column and the operand have an element (or a point) in common. */
    overlaps(column: string, value: PostgrestArrayOperand): this {
        return this.push(column, `ov.${encodeArrayOperand(value)}`);
    }

    /** `>>`: strictly right of the range. */
    rangeGt(column: string, range: string): this {
        return this.push(column, `sr.${range}`);
    }
    /** `&>`: does not extend to the left of the range. */
    rangeGte(column: string, range: string): this {
        return this.push(column, `nxl.${range}`);
    }
    /** `<<`: strictly left of the range. */
    rangeLt(column: string, range: string): this {
        return this.push(column, `sl.${range}`);
    }
    /** `&<`: does not extend to the right of the range. */
    rangeLte(column: string, range: string): this {
        return this.push(column, `nxr.${range}`);
    }
    /** `-|-`: adjacent to the range. */
    rangeAdjacent(column: string, range: string): this {
        return this.push(column, `adj.${range}`);
    }

    private push(key: string, value: string): this {
        this.filters.append(key, value);
        return this;
    }

    // --- modifiers ---------------------------------------------------------

    order(column: string, options: OrderOptions = {}): this {
        const direction = options.ascending === false ? 'desc' : 'asc';
        const nulls =
            options.nullsFirst === undefined ? '' : options.nullsFirst ? '.nullsfirst' : '.nullslast';
        const prefix = referenced(options);
        const parts = this.orderParts.get(prefix) ?? [];
        parts.push(`${column}.${direction}${nulls}`);
        this.orderParts.set(prefix, parts);
        return this;
    }

    limit(count: number, options: ReferencedTableOption = {}): this {
        this.limits.set(referenced(options), count);
        return this;
    }

    /** Inclusive range -> offset/limit. `range(0, 9)` fetches 10 rows from offset 0. */
    range(from: number, to: number, options: ReferencedTableOption = {}): this {
        const prefix = referenced(options);
        this.offsets.set(prefix, from);
        this.limits.set(prefix, to - from + 1);
        return this;
    }

    /**
     * Every matching row, one page at a time.
     *
     * An unbounded `select()` stops at the server's `api.rest.maxRows` (1000 by
     * default) and says nothing about it: the caller gets a full-looking array
     * that is missing everything past the cap. This walks the result instead, so
     * "give me all of them" is expressible without knowing the cap exists.
     *
     * ```ts
     * for await (const row of client.from('events').select('*').stream()) { ... }
     * ```
     *
     * The pages are separate requests, so rows inserted while the walk is running
     * may be seen or missed depending on when they land. Order by a stable column
     * if that matters.
     */
    async *stream(options: PaginateOptions = {}): AsyncGenerator<Row, void, undefined> {
        for await (const page of this.paginate(options)) {
            for (const row of page.rows) yield row;
        }
    }

    /**
     * Like `stream()`, a page at a time rather than a row at a time, with the
     * total from `Content-Range` when the server sent one.
     *
     * An error ends the walk by throwing, unlike awaiting the builder, which
     * resolves `{ data, error }`. A `for await` loop has nowhere to put an error
     * value, and silently ending the iteration early would look exactly like
     * reaching the last page.
     */
    async *paginate(
        options: PaginateOptions = {},
    ): AsyncGenerator<{ rows: Row[]; from: number; count: number | null }, void, undefined> {
        const pageSize = options.pageSize ?? 1000;
        if (!Number.isInteger(pageSize) || pageSize < 1) {
            throw new Error(`pageSize must be a positive integer, received ${String(options.pageSize)}`);
        }
        if (this.method !== 'GET') {
            throw new Error('stream() and paginate() read rows: call them on a select(), not on a write.');
        }
        if (this.rowMode !== 'many') {
            throw new Error('stream() and paginate() walk many rows: drop single() / maybeSingle().');
        }

        let from = 0;
        for (; ;) {
            this.range(from, from + pageSize - 1);
            const result = await this.execute();
            if (result.error) throw Object.assign(new Error(result.error.message), result.error);

            const rows = (result.data ?? []) as Row[];
            if (rows.length) yield { rows, from, count: result.count };
            from += rows.length;
            // A server cap can make any page short. Only an empty page or a known
            // total proves that the walk is complete.
            if (!rows.length || (result.count !== null && from >= result.count)) return;
        }
    }

    /** Cancel the in-flight request when the signal aborts. */
    abortSignal(signal: AbortSignal): this {
        this.signal = signal;
        return this;
    }

    /**
     * Send one more header with this request only, as in supabase-js. The usual
     * one is `x-captcha-response`, for a table the project guards with CAPTCHA
     * (Authentication > Attack Protection).
     */
    setHeader(name: string, value: string): this {
        this.extraHeaders[name] = value;
        return this;
    }

    /**
     * Re-type the rows. Purely a compile-time cast, for cases the generated
     * `Database` cannot express (a computed column, an embedded shape).
     */
    returns<T extends object>(): PostgrestQueryBuilder<T> {
        return this as unknown as PostgrestQueryBuilder<T>;
    }

    /** supabase-js's newer name for `returns()`. Also a compile-time cast only. */
    overrideTypes<T extends object>(): PostgrestQueryBuilder<T> {
        return this as unknown as PostgrestQueryBuilder<T>;
    }

    /**
     * Reject the query instead of resolving `{ data: null, error }`.
     *
     * The `{ data, error }` envelope is the default in both SDKs because it makes
     * a failure impossible to skip by accident. `throwOnError()` is the opt-out
     * for code that would rather use try/catch, and ported Supabase code uses it
     * widely enough that its absence is a `TypeError: … is not a function` on the
     * first query.
     */
    throwOnError(): this {
        this.shouldThrow = true;
        return this;
    }

    /**
     * Fail the write if it would touch more than `count` rows.
     *
     * A guard against the missing-filter class of accident (`update()` with a
     * typo'd `.eq()`), sent as `Prefer: max-affected`. A server that does not
     * implement it ignores the preference, so treat this as a safety net rather
     * than a guarantee, and keep the filter correct.
     */
    maxAffected(count: number): this {
        this.prefer.push('handling=strict', `max-affected=${count}`);
        return this;
    }

    /**
     * Roll the transaction back after running the query, so nothing is persisted.
     * Useful for validating a write, or previewing what it would return.
     */
    rollback(): this {
        this.prefer.push('tx=rollback');
        return this;
    }

    /** Ask for GeoJSON instead of rows. The result resolves to the parsed object. */
    geojson(): PostgrestExplainBuilder {
        this.accept = 'application/geo+json';
        this.responseKind = 'text-json';
        return this as unknown as PostgrestExplainBuilder;
    }

    /** Ask for `text/csv` instead of JSON. The result resolves to a string. */
    csv(): PostgrestTextBuilder {
        this.accept = 'text/csv';
        this.responseKind = 'text';
        return this as unknown as PostgrestTextBuilder;
    }

    /** Ask the server for the query plan. Admin-only, and off by default. */
    explain(options: ExplainOptions = {}): PostgrestExplainBuilder {
        const format = options.format ?? 'text';
        const flags = (['analyze', 'verbose', 'settings', 'buffers', 'wal'] as const)
            .filter(flag => options[flag])
            .join('|');
        const forMediatype = this.accept ?? 'application/json';
        this.accept = `application/vnd.pgrst.plan+${format}; for="${forMediatype}"; options=${flags};`;
        this.responseKind = format === 'json' ? 'text-json' : 'text';
        return this as unknown as PostgrestExplainBuilder;
    }

    single(): PostgrestSingleBuilder<Row> {
        this.rowMode = 'single';
        return this as unknown as PostgrestSingleBuilder<Row>;
    }

    maybeSingle(): PostgrestSingleBuilder<Row> {
        this.rowMode = 'maybeSingle';
        return this as unknown as PostgrestSingleBuilder<Row>;
    }

    // --- execution ---------------------------------------------------------

    /** The URL path (with query string) this builder targets. Exposed for tests. */
    toPath(): string {
        const params = new URLSearchParams();
        if (this.columns && this.columns !== '*') params.set('select', this.columns);
        for (const [key, value] of this.extras) params.append(key, value);
        // `append`, never `set`: two filters on one column are two conditions.
        this.filters.forEach((value, key) => params.append(key, value));
        for (const [prefix, parts] of this.orderParts) {
            if (parts.length) params.append(scopedKey(prefix, 'order'), parts.join(','));
        }
        for (const [prefix, value] of this.limits) {
            params.append(scopedKey(prefix, 'limit'), String(value));
        }
        for (const [prefix, value] of this.offsets) {
            params.append(scopedKey(prefix, 'offset'), String(value));
        }
        const query = params.toString();
        return `${contractPath.rest(this.model)}${query ? `?${query}` : ''}`;
    }

    /**
     * The request this builder would send, as data.
     *
     * `client.transaction()` needs to describe several writes without issuing
     * them, and the method and body are otherwise private. Exposed rather than
     * reached into: a batch built from `(builder as any).method` would break the
     * first time this class was refactored.
     */
    toRequest(): { method: string; model: string; query: Record<string, string[]>; body: unknown } {
        if (this.prefer.length || Object.keys(this.extraHeaders).length || this.countOption
            || this.accept || this.signal || this.rowMode !== 'many' || this.shouldThrow) {
            throw new Error('transaction(): per-operation preferences, headers, signals and result modifiers are not supported by the batch endpoint.');
        }
        const path = this.toPath();
        const queryString = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
        const query: Record<string, string[]> = {};
        // Repeated keys are two conditions on one column, never one overwriting the
        // other, so the value is always a list.
        // `forEach` rather than iteration: this package targets a lib without the
        // URLSearchParams iterator declaration, and forEach is in every runtime.
        new URLSearchParams(queryString).forEach((value, key) => {
            (query[key] ??= []).push(value);
        });
        return { method: this.method, model: this.model, query, body: this.body };
    }

    /** The headers this builder sends. Exposed for tests alongside `toPath()`. */
    toHeaders(): Record<string, string> {
        const headers: Record<string, string> = { ...this.extraHeaders };
        const prefer = [...this.prefer];
        if (this.countOption) prefer.push(`count=${this.countOption}`);
        // Use the same write contract with and without compat mode.
        if (this.isWrite()) prefer.push(`return=${this.selectCalled ? 'representation' : 'minimal'}`);
        if (prefer.length) headers['Prefer'] = prefer.join(',');
        if (this.accept) headers['Accept'] = this.accept;
        return headers;
    }

    private async execute(): Promise<PostgrestResponse<unknown>> {
        if (this.transactionOnly) {
            throw new Error('transaction(): do not await individual operations; the batch executes them together.');
        }
        const path = this.toPath();
        const headers = this.toHeaders();
        try {
            if (this.responseKind !== 'json') {
                const res = await this.http.requestRaw(path, {
                    method: this.method,
                    body: this.body,
                    headers,
                    signal: this.signal,
                });
                const text = await res.text();
                const data = this.responseKind === 'text-json' ? safeJson(text) : text;
                return { data, error: null, count: parseContentRange(res.headers.get('content-range')) };
            }

            const result = await this.http.requestWithHeaders<Row[]>(path, {
                method: this.method,
                body: this.body,
                headers,
                signal: this.signal,
            });
            const count = parseContentRange(result.headers.get('content-range'));

            // A HEAD request has no body by definition: the count is the whole answer.
            if (this.headOnly) return { data: null, error: null, count };

            // `return=minimal` was sent: the write happened, there are no rows to
            // report, and supabase-js resolves `{ data: null }` for exactly this case.
            if (this.isWrite() && !this.selectCalled) {
                return { data: null, error: null, count };
            }

            const rows = result.data;
            return this.finish(Array.isArray(rows) ? rows : rows == null ? [] : [rows], count);
        } catch (err) {
            const error = toError(err);
            // A filter matching nothing is a 404 here and an empty array in
            // supabase-js. Under compat the write resolves empty, which is what
            // ported code branches on (`if (!data.length)`), instead of a thrown or
            // surfaced error it never had a handler for.
            if (this.compat && error.status === 404 && (this.method === 'PATCH' || this.method === 'DELETE')) {
                return this.finish([], 0);
            }
            return { data: null, error, count: null };
        }
    }

    private isWrite(): boolean {
        return this.method === 'POST' || this.method === 'PATCH' || this.method === 'DELETE';
    }

    /** Apply `single()` / `maybeSingle()` to a row list. The one place row mode is read. */
    private finish(list: unknown[], count: number | null): PostgrestResponse<unknown> {
        if (this.rowMode === 'single' || this.rowMode === 'maybeSingle') {
            if (list.length > 1 || (this.rowMode === 'single' && list.length === 0)) {
                const error: MotherbaseError = {
                    message: 'JSON object requested, multiple (or no) rows returned',
                    code: 'PGRST116',
                };
                return { data: null, error, count };
            }
            return { data: list.length ? list[0] : null, error: null, count };
        }
        return { data: list, error: null, count };
    }

    then<TResult1 = PostgrestResponse<Row[]>, TResult2 = never>(
        onfulfilled?: ((value: PostgrestResponse<Row[]>) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
        // `throwOnError()` is applied here rather than inside execute() so every
        // builder variant (single, csv, explain, geojson) inherits it: they are all
        // the same object, cast, and `then` is the one path they share.
        const settled = this.execute().then(result => {
            if (this.shouldThrow && result.error) {
                throw Object.assign(new Error(result.error.message), result.error);
            }
            return result;
        });
        return settled.then(onfulfilled as never, onrejected);
    }
}