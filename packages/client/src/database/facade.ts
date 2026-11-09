/**
 * Prisma-shaped access to a table, as an alternative to `client.from()`:
 *
 * ```ts
 * const posts = await client.db.posts.findMany({
 *   where: { published: true, views: { gt: 100 } },
 *   select: { id: true, title: true },
 *   orderBy: { created_at: 'desc' },
 *   take: 20,
 * })
 * ```
 *
 * A second syntax, not a second query engine. Each method translates its
 * arguments into calls on the same `PostgrestQueryBuilder` that `from()`
 * returns (`where: { views: { gt: 100 } }` becomes `.gt('views', 100)`), so
 * both send identical requests. What the facade cannot express (embedded
 * relations, `or`, json paths) stays one `client.from()` away.
 *
 * Failures throw, as in Prisma. A facade resolving `{ data, error }` would
 * differ from `from()` in argument shape only.
 */
import type { PostgrestQueryBuilder } from '../postgrest/query-builder.js';
import type { GenericSchema, InsertOf, RelationName, RowOf, UpdateOf } from './types.js';

// ── What the caller writes ────────────────────────────────────────────────────

/** The conditions one column can take in a `where`. Several on one column are ANDed. */
export interface WhereOperators<Value> {
  /** Equal to the value. `null` matches NULL. */
  equals?: Value | null;
  /** Different from the value. `null` matches every non-NULL value. */
  not?: Value | null;
  /** Equal to one of the values. */
  in?: readonly Value[];
  /** Greater than. */
  gt?: Value;
  /** Greater than or equal. */
  gte?: Value;
  /** Less than. */
  lt?: Value;
  /** Less than or equal. */
  lte?: Value;
  /** Text containing this string, case-sensitive. */
  contains?: string;
  /** Text starting with this string, case-sensitive. */
  startsWith?: string;
  /** Text ending with this string, case-sensitive. */
  endsWith?: string;
}

/** Per column, a bare value (meaning `equals`) or operators. Columns are ANDed. */
export type Where<Row> = { [Column in keyof Row]?: Row[Column] | WhereOperators<Row[Column]> };
/** The columns to read: `{ id: true, title: true }`. Omitted, every column is read. */
export type SelectColumns<Row> = { [Column in keyof Row]?: true };
/** Sort order per column, applied in key order: `{ created_at: 'desc', id: 'asc' }`. */
export type OrderBy<Row> = { [Column in keyof Row]?: 'asc' | 'desc' };

/** What `findMany()` and `findFirst()` accept. Every field is optional. */
export interface FindManyArgs<Row, Select extends SelectColumns<Row> | undefined = undefined> {
  /** Which rows: `{ published: true, views: { gt: 100 } }`. */
  where?: Where<Row>;
  /** Which columns: `{ id: true, title: true }`. The result type narrows to them. */
  select?: Select;
  /** Sort order: `{ created_at: 'desc' }`. */
  orderBy?: OrderBy<Row>;
  /** Return at most this many rows. */
  take?: number;
  /** Skip this many rows first. Needs `take`. */
  skip?: number;
}

/** What `findUnique()` accepts: a `where` that must name a column, and optionally a `select`. */
export interface FindUniqueArgs<Row, Select extends SelectColumns<Row> | undefined = undefined> {
  where: Where<Row>;
  select?: Select;
}

/** What `createMany()` accepts. `skipDuplicates` drops rows whose primary key already exists. */
export interface CreateManyArgs<Insert> {
  data: Insert[];
  skipDuplicates?: boolean;
}

/** `select: { id: true }` narrows each result to `Pick<Row, 'id'>`; no select is the whole row. */
export type Selected<Row, Select> = Select extends SelectColumns<Row>
  ? Pick<Row, Extract<keyof Select, keyof Row>>
  : Row;

/**
 * One table, Prisma-style: what `client.db.<table>` returns. Every method
 * throws on failure.
 */
export interface TableFacade<Row, Insert, Update> {
  /**
   * Read every row matching `where`.
   * @example await client.db.posts.findMany({ where: { published: true }, orderBy: { created_at: 'desc' }, take: 20 })
   */
  findMany<Select extends SelectColumns<Row> | undefined = undefined>(
    args?: FindManyArgs<Row, Select>,
  ): Promise<Selected<Row, Select>[]>;
  /**
   * Read the first row matching `where`, or `null` when none does.
   * @example await client.db.posts.findFirst({ where: { slug } })
   */
  findFirst<Select extends SelectColumns<Row> | undefined = undefined>(
    args?: Omit<FindManyArgs<Row, Select>, 'take'>,
  ): Promise<Selected<Row, Select> | null>;
  /**
   * Like `findFirst()`, but throws when no row matches.
   * @example await client.db.posts.findFirstOrThrow({ where: { slug } })
   */
  findFirstOrThrow<Select extends SelectColumns<Row> | undefined = undefined>(
    args?: Omit<FindManyArgs<Row, Select>, 'take'>,
  ): Promise<Selected<Row, Select>>;
  /**
   * Read the one row matching `where`, or `null` when none does. Throws if
   * several match: the database knows which columns are unique, the facade
   * only sees the answer.
   * @example await client.db.posts.findUnique({ where: { id } })
   */
  findUnique<Select extends SelectColumns<Row> | undefined = undefined>(
    args: FindUniqueArgs<Row, Select>,
  ): Promise<Selected<Row, Select> | null>;
  /**
   * Like `findUnique()`, but throws when no row matches.
   * @example await client.db.posts.findUniqueOrThrow({ where: { id } })
   */
  findUniqueOrThrow<Select extends SelectColumns<Row> | undefined = undefined>(
    args: FindUniqueArgs<Row, Select>,
  ): Promise<Selected<Row, Select>>;
  /**
   * Count the rows matching `where`, without reading them.
   * @example await client.db.posts.count({ where: { published: true } })
   */
  count(args?: { where?: Where<Row> }): Promise<number>;
  /**
   * Insert one row and resolve it as stored, defaults and generated ids included.
   * @example const post = await client.db.posts.create({ data: { title } })
   */
  create(args: { data: Insert }): Promise<Row>;
  /**
   * Insert several rows in one request and resolve how many were inserted.
   * `skipDuplicates` drops rows whose primary key already exists.
   * @example await client.db.tags.createMany({ data: [{ name: 'a' }, { name: 'b' }], skipDuplicates: true })
   */
  createMany(args: CreateManyArgs<Insert>): Promise<{ count: number }>;
  /**
   * `createMany()` resolving the inserted rows instead of their count.
   * @example const tags = await client.db.tags.createManyAndReturn({ data: [{ name: 'a' }] })
   */
  createManyAndReturn(args: CreateManyArgs<Insert>): Promise<Row[]>;
  /**
   * Update the one row matching `where` and resolve it. Throws when none
   * matches, and when several would: the server refuses before writing.
   * @example await client.db.posts.update({ where: { id }, data: { title } })
   */
  update(args: { where: Where<Row>; data: Update }): Promise<Row>;
  /**
   * Update every row matching `where` and resolve the updated rows (Prisma
   * resolves `{ count }`). Throws if `where` matches no column, so an id that
   * is `undefined` at runtime cannot update the whole table.
   * @example await client.db.posts.updateMany({ where: { id }, data: { title } })
   */
  updateMany(args: { where: Where<Row>; data: Update }): Promise<Row[]>;
  /**
   * Delete every row matching `where` and resolve the deleted rows. Throws if
   * `where` matches no column, so an id that is `undefined` at runtime cannot
   * empty the table.
   * @example await client.db.posts.deleteMany({ where: { id } })
   */
  deleteMany(args: { where: Where<Row> }): Promise<Row[]>;
  /**
   * Delete the one row matching `where` and resolve it. Throws when none
   * matches, and when several would: the server refuses before deleting.
   * @example await client.db.posts.delete({ where: { id } })
   */
  delete(args: { where: Where<Row> }): Promise<Row>;
  /**
   * Update the row matching `where` with `update`, or insert `create` when
   * none matches, and resolve the row.
   * @example await client.db.likes.upsert({ where: { post_id, user_id }, create: { post_id, user_id }, update: {} })
   */
  upsert(args: { where: Where<Row>; create: Insert; update: Update }): Promise<Row>;
}

/** `client.db`: one `TableFacade` per table or view of the generated `Database`. */
export type DatabaseFacade<Schema extends GenericSchema> = {
  [Name in RelationName<Schema>]: TableFacade<RowOf<Schema, Name>, InsertOf<Schema, Name>, UpdateOf<Schema, Name>>;
};

// ── Translation to the query builder ──────────────────────────────────────────

// The caller-facing types above carry the row; the builder underneath is driven untyped.
type Builder = PostgrestQueryBuilder<any>;
type Operator = keyof WhereOperators<unknown>;

const OPERATORS = new Set<string>([
  'equals', 'not', 'in', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'endsWith',
] satisfies Operator[]);

interface Filter {
  column: string;
  operator: Operator;
  value: unknown;
}

/**
 * An operator object, as opposed to a bare value. Every key must be an
 * operator, so a json column compared to `{ theme: 'dark' }` stays a value.
 */
function isOperators(condition: unknown): condition is Partial<Record<Operator, unknown>> {
  if (typeof condition !== 'object' || condition === null || Array.isArray(condition)) return false;
  const keys = Object.keys(condition);
  return keys.length > 0 && keys.every(key => OPERATORS.has(key));
}

/**
 * Flatten a `where` into one filter per condition:
 * `{ published: true, views: { gt: 1, lt: 9 } }` is three filters.
 *
 * An `undefined` value means "no filter", as in Prisma, so `{ author_id: maybeId }`
 * reads naturally. `requireFilters` is what stops that from widening a write.
 */
export function filtersOf(where: object = {}): Filter[] {
  const filters: Filter[] = [];
  for (const [column, condition] of Object.entries(where)) {
    if (isOperators(condition)) {
      for (const [operator, value] of Object.entries(condition)) {
        filters.push({ column, operator: operator as Operator, value });
      }
    } else {
      filters.push({ column, operator: 'equals', value: condition });
    }
  }
  return filters.filter(filter => filter.value !== undefined);
}

function applyFilter(query: Builder, { column, operator, value }: Filter): void {
  const v = value as any;
  switch (operator) {
    // SQL's `= NULL` matches nothing: a null comparison has to be `IS NULL`.
    case 'equals': if (value === null) query.is(column, null); else query.eq(column, v); return;
    case 'not': if (value === null) query.not(column, 'is', null); else query.neq(column, v); return;
    case 'in': query.in(column, v); return;
    case 'gt': query.gt(column, v); return;
    case 'gte': query.gte(column, v); return;
    case 'lt': query.lt(column, v); return;
    case 'lte': query.lte(column, v); return;
    // `*` is PostgREST's LIKE wildcard.
    // ponytail: a `*` inside the value is a wildcard too; escape it if literal stars need matching.
    case 'contains': query.like(column, `*${v}*`); return;
    case 'startsWith': query.like(column, `${v}*`); return;
    case 'endsWith': query.like(column, `*${v}`); return;
  }
}

/**
 * A write with no filter touches every row. Prisma allows it; here it takes
 * `client.from(table)` written out, so an id that was `undefined` at runtime
 * cannot turn a targeted delete into a table wipe.
 */
function requireFilters(where: object, method: string): Filter[] {
  const filters = filtersOf(where);
  if (!filters.length) {
    throw new Error(`${method}(): where matched no column. Use client.from(table) to target every row.`);
  }
  return filters;
}

/** `query` narrowed by a `where` that must not be empty. */
function narrowed(query: Builder, where: object, method: string): Builder {
  for (const filter of requireFilters(where, method)) applyFilter(query, filter);
  return query;
}

/**
 * A PATCH or DELETE matching nothing answers 404 here (under compat it
 * resolves empty instead). Either way it means no row, not a failure.
 */
function noRows(error: { status?: number }): unknown[] {
  if (error.status === 404) return [];
  throw error;
}

/** The read half: `findMany` arguments applied to a fresh builder. Exported for tests. */
export function applyFindArgs(query: Builder, args: FindManyArgs<any, any> = {}): Builder {
  query.select(args.select ? Object.keys(args.select).join(',') : '*');
  for (const filter of filtersOf(args.where)) applyFilter(query, filter);
  for (const [column, direction] of Object.entries(args.orderBy ?? {})) {
    query.order(column, { ascending: direction === 'asc' });
  }
  if (args.take !== undefined) {
    const skip = args.skip ?? 0;
    query.range(skip, skip + args.take - 1);
  } else if (args.skip !== undefined) {
    throw new Error('findMany(): skip needs take, the builder only offsets through range().');
  }
  return query;
}

/**
 * `data` of a query sent with `throwOnError()`. Such a query only resolves on
 * success, so `data` is set, whatever the `{ data, error }` envelope type says.
 */
async function dataOf(query: PromiseLike<{ data: unknown }>): Promise<any> {
  return (await query).data;
}

/**
 * One table's facade. `newQuery` returns a fresh builder for that table on
 * every call. Every method is `async`, so a refused write rejects like a failed
 * one instead of throwing synchronously.
 */
export function tableFacade<Row, Insert, Update>(newQuery: () => Builder): TableFacade<Row, Insert, Update> {
  async function createManyAndReturn({ data, skipDuplicates }: CreateManyArgs<Insert>): Promise<Row[]> {
    const rows = data as object[];
    const query = skipDuplicates ? newQuery().upsert(rows, { ignoreDuplicates: true }) : newQuery().insert(rows);
    return dataOf(query.select().throwOnError());
  }

  return {
    async findMany(args) {
      return dataOf(applyFindArgs(newQuery(), args).throwOnError());
    },

    async findFirst(args) {
      return dataOf(applyFindArgs(newQuery(), { ...args, take: 1 }).throwOnError().maybeSingle());
    },

    async findFirstOrThrow(args) {
      return dataOf(applyFindArgs(newQuery(), { ...args, take: 1 }).throwOnError().single());
    },

    // Two rows are enough to tell a unique match from several, without reading them all.
    async findUnique(args) {
      requireFilters(args.where, 'findUnique');
      return dataOf(applyFindArgs(newQuery(), { ...args, take: 2 }).throwOnError().maybeSingle());
    },

    async findUniqueOrThrow(args) {
      requireFilters(args.where, 'findUniqueOrThrow');
      return dataOf(applyFindArgs(newQuery(), { ...args, take: 2 }).throwOnError().single());
    },

    async count(args) {
      const query = newQuery().select('*', { count: 'exact', head: true });
      for (const filter of filtersOf(args?.where)) applyFilter(query, filter);
      return (await query.throwOnError()).count ?? 0;
    },

    async create({ data }) {
      return dataOf(newQuery().insert(data as object).select().throwOnError().single());
    },

    // The server sends no Content-Range on writes, so the count is of the rows sent back.
    async createMany(args) {
      return { count: (await createManyAndReturn(args)).length };
    },

    createManyAndReturn,

    async update({ where, data }) {
      const query = narrowed(newQuery().update(data as object), where, 'update').maxAffected(1);
      return dataOf(query.select().throwOnError().single());
    },

    async updateMany({ where, data }) {
      return dataOf(narrowed(newQuery().update(data as object), where, 'updateMany').select().throwOnError());
    },

    async delete({ where }) {
      const query = narrowed(newQuery().delete(), where, 'delete').maxAffected(1);
      return dataOf(query.select().throwOnError().single());
    },

    async deleteMany({ where }) {
      return dataOf(narrowed(newQuery().delete(), where, 'deleteMany').select().throwOnError());
    },

    // ponytail: update, then insert if nothing matched. A concurrent insert in
    // between fails on the unique constraint instead of merging; Prisma's own
    // non-native upsert has the same gap.
    async upsert({ where, create, update }) {
      const query = narrowed(newQuery().update(update as object), where, 'upsert').maxAffected(1);
      const [updated] = await dataOf(query.select().throwOnError()).catch(noRows);
      return updated ?? dataOf(newQuery().insert(create as object).select().throwOnError().single());
    },
  };
}
