/**
 * React Query / SWR glue: cache keys and fetchers for Motherbase queries.
 *
 * Every app that reaches for a data-fetching library writes the same two
 * things, badly: a key convention, and a fetcher that remembers to throw on
 * `{ error }` instead of caching it as data. The second one is the bug. A
 * fetcher that returns `{ data: null, error }` resolves successfully as far as
 * React Query is concerned, so the error is cached, `isError` stays false, and
 * the UI renders an empty list forever.
 *
 * No dependency on React Query here, and none needed: the returned objects are
 * plain `{ queryKey, queryFn }`, which is what `useQuery` takes. The same
 * objects work with SWR by passing `queryKey` as the key and `queryFn` as the
 * fetcher.
 */
import type { MotherbaseClient } from '../index.js';
import type { TypedQuery } from './types.js';
import type { PostgrestResponse } from '../postgrest/index.js';

/**
 * The builder handed to a `build` callback: the same object `client.from()`
 * returns, narrowed to the row type the helper was called with. Typed rather
 * than `any`, so `.eq('athor', …)` is a compile error inside the callback and
 * the editor completes the column names.
 */
export type QueryBuilderFor<Row extends object> = TypedQuery<Row, Partial<Row>, Partial<Row>>;

/**
 * Any client, whatever `Database` it was created with.
 *
 * ponytail: the generic arguments are erased here because `from()`'s relation
 * names are literal types that differ per `Database`, so no single parameter
 * type accepts them all. The erasure stops at this boundary: everything the
 * helpers hand back to the caller is typed through `Row`.
 */
type AnyClient = MotherbaseClient<any, any, any>;

/** `from()` on an erased client, re-typed to the row the caller asked for. */
function queryFor<Row extends object>(client: AnyClient, table: string): QueryBuilderFor<Row> {
  return client.from<Row>(table as never) as QueryBuilderFor<Row>;
}

/**
 * Cache keys, hierarchical so invalidation can be coarse.
 *
 * `['motherbase', 'table', 'posts']` is a prefix of every key below it, so
 * `invalidateQueries({ queryKey: keys.table('posts') })` reaches every list and
 * every row of that table, which is what you want after a write. Anything
 * narrower leaves a stale list on screen next to a fresh row.
 */
export const keys = {
  all: ['motherbase'] as const,
  table: (table: string) => ['motherbase', 'table', table] as const,
  list: (table: string, filters?: unknown) =>
  (filters === undefined
    ? (['motherbase', 'table', table, 'list'] as const)
    : (['motherbase', 'table', table, 'list', filters] as const)),
  row: (table: string, id: unknown) => ['motherbase', 'table', table, 'row', id] as const,
};

/** Unwrap a `{ data, error }` result the way a cache library needs: throw on error. */
async function unwrap<T>(result: PromiseLike<PostgrestResponse<T>>): Promise<T> {
  const { data, error } = await result;
  if (error) throw Object.assign(new Error(error.message), error);
  return data as T;
}

export interface QueryOptions<T> {
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
}

/**
 * A list query.
 *
 * `build` receives the query builder so filters, ordering and column selection
 * stay in the caller's hands; whatever it returns is awaited and unwrapped.
 * Pass `filters` to make the key unique per filter set, or two different
 * filtered lists of the same table will share one cache entry and overwrite
 * each other.
 *
 * ```ts
 * useQuery(listQuery(client, 'posts', {
 *   filters: { author },
 *   build: q => q.select('*').eq('author', author).order('created_at'),
 * }))
 * ```
 */
export function listQuery<Row extends object = Record<string, unknown>>(
  client: AnyClient,
  table: string,
  options: {
    filters?: unknown;
    build?: (query: QueryBuilderFor<Row>) => PromiseLike<PostgrestResponse<Row[]>>;
  } = {},
): QueryOptions<Row[]> {
  const { filters, build } = options;
  return {
    queryKey: keys.list(table, filters),
    queryFn: () => {
      const base = queryFor<Row>(client, table);
      return unwrap<Row[]>(build ? build(base) : (base.select('*') as PromiseLike<PostgrestResponse<Row[]>>));
    },
  };
}

/**
 * One row by primary key (or by any unique column, through `column`).
 *
 * Resolves `null` rather than throwing when the row is not there: "not found"
 * is an answer, and a cache library that receives it as an error retries it.
 */
export function rowQuery<Row extends object = Record<string, unknown>>(
  client: AnyClient,
  table: string,
  id: unknown,
  options: { column?: keyof Row & string; columns?: string } = {},
): QueryOptions<Row | null> {
  const { column = 'id' as keyof Row & string, columns = '*' } = options;
  return {
    queryKey: keys.row(table, id),
    queryFn: () =>
      unwrap<Row | null>(
        queryFor<Row>(client, table)
          // `columns` is a runtime string, so it cannot be checked against the
          // row the way a literal passed to `.select()` is.
          .select(columns as '*')
          .eq(column, id as never)
          .maybeSingle() as PromiseLike<PostgrestResponse<Row | null>>,
      ),
  };
}

/**
 * Every row, walked through `stream()` rather than capped at the server's
 * `api.rest.maxRows`.
 *
 * Separate from `listQuery` on purpose: this issues one request per page, so it
 * belongs to lists that are known to be small enough to hold in memory and
 * large enough to exceed the cap. Anything unbounded wants real pagination.
 */
export function allRowsQuery<Row extends object = Record<string, unknown>>(
  client: AnyClient,
  table: string,
  options: {
    filters?: unknown;
    pageSize?: number;
    build?: (query: QueryBuilderFor<Row>) => QueryBuilderFor<Row>;
  } = {},
): QueryOptions<Row[]> {
  const { filters, pageSize, build } = options;
  return {
    queryKey: [...keys.list(table, filters), 'all'],
    queryFn: async () => {
      const base = queryFor<Row>(client, table);
      const query = build ? build(base) : (base.select('*') as QueryBuilderFor<Row>);
      const rows: Row[] = [];
      for await (const row of query.stream({ pageSize })) rows.push(row as Row);
      return rows;
    },
  };
}
