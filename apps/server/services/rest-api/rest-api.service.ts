import BaseContext from '../../context/base-context';
import { maskRow } from '../../constants/admin.constants';
import { HttpException } from '../../exceptions/http-exception';
import { parseQuery, type Filter, type ParsedQuery } from './postgrest-parser';
import { getCatalog } from './catalog';
import type { PoolClient } from 'pg';
import { rlsContextFor, type RlsUser } from '../../lib/rls-claims';
import { rlsEnabledTables } from '../../lib/rls-pool';
import { logActivity } from '../../lib/activity-log';
import { errorMessage } from '../../lib/errors';
import { quoteIdent } from '../admin/schema-ddl';
import { bindNamedArgs, bindSingleObjectArg, pickOverload } from './rpc-args';
import {
  createContext,
  createEmbedScope,
  createParams,
  filterToSql,
  orderToSql,
  selectToSql,
  type CompileContext,
} from './sql-compiler';
import { captureWrite } from './capture-write';
import { contentRange, parsePrefer, type CountMode, type Preferences } from './http-semantics';
import {
  assertEmbeddable,
  assertKnownDataFields,
  assertPatchBody,
  assertScopedMutation,
  conflictTarget,
  COUNT_COLUMN,
  isRestExposable,
  relationSql,
  REST_SCHEMA,
  resolveRpcSchema,
  targetOrThrow,
  toRestModel,
  type RestModelMeta,
  type RestTarget,
} from './rest-model';

/** Options a controller may pass down from the request headers. */
export interface ReadOptions {
  prefer?: Preferences;
  /** `Range` header, applied only when `?limit`/`?offset` are absent. */
  range?: { offset: number; limit?: number } | null;
  /** A HEAD request: compute the count, return no rows. */
  head?: boolean;
  /** Return the query plan instead of the rows. Admin only, see `handleSelect`. */
  explain?: boolean;
}

export interface ReadResult {
  rows: any[];
  /** `null` unless the caller asked for a count through `Prefer: count=`. */
  count: number | null;
  offset: number;
  /** Ready-to-send `Content-Range` value. */
  contentRange: string;
  /** Present only for an admin `EXPLAIN` request. */
  plan?: unknown;
}

export interface WriteOptions {
  prefer?: Preferences;
  /** The request query string, for `?on_conflict=` on a write. */
  query?: Record<string, unknown>;
  /**
   * Run on an ALREADY OPEN RLS transaction instead of opening one.
   *
   * Set only by `handleBatch`, which is how several writes become one atomic
   * unit. The role and claims are already set on that connection, by the same
   * `rlsContextFor(user)` this handler would have used, so reusing it changes
   * who the statement runs as not at all.
   */
  tx?: PoolClient;
  /** Batch callbacks run only after the enclosing transaction commits. */
  afterCommit?: Array<() => void>;
}

/** One write inside `handleBatch`. Reads are refused; see the method comment. */
export interface BatchOperation {
  method: 'POST' | 'PATCH' | 'DELETE';
  model: string;
  /** Filters for PATCH/DELETE, and `on_conflict` for an upsert. */
  query?: Record<string, unknown>;
  body?: unknown;
}

const BATCH_METHODS = new Set<string>(['POST', 'PATCH', 'DELETE']);

/**
 * A batch holds one Postgres transaction open for its whole run, so its length
 * is how long every other writer waits on the rows it touches. This is the
 * ceiling that keeps a runaway client from parking a connection.
 */
const MAX_BATCH_OPERATIONS = 100;

const DEFAULT_PREFER = Object.freeze(parsePrefer(undefined));

/**
 * Thrown from inside a write's transaction to satisfy `Prefer: tx=rollback`.
 *
 * Throwing is the only way to roll a transaction back from inside the callback,
 * and the rows still have to reach the caller: a dry run that reports nothing
 * answers none of the questions it was asked. So the rows ride on the error and
 * the write path unwraps it.
 */
class RollbackRequested extends Error {
  constructor(readonly rows: any[]) {
    super('Prefer: tx=rollback');
    this.name = 'RollbackRequested';
  }
}

/** One resource the REST router actually serves. */
export interface RestResource {
  name: string;
  /** Path relative to the project API root. */
  path: string;
  /** Real key columns; empty when the table has none, which PATCH/DELETE need to know. */
  primaryKey: string[];
  rlsEnabled: boolean;
  columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    hasDefault: boolean;
    isPrimaryKey: boolean;
    isGenerated: boolean;
  }>;
}

// ── Service ──────────────────────────────────────────────────────────────────

export class RestApiService extends BaseContext {
  /** Every REST-reachable table, read straight from the catalog snapshot. */
  async listModels(): Promise<RestModelMeta[]> {
    const catalog = await getCatalog();
    return catalog.tablesIn(REST_SCHEMA).filter(isRestExposable).map(toRestModel);
  }

  /**
   * The REST surface as the API docs screen needs to describe it.
   *
   * That screen used to build its endpoint list from the Studio table list,
   * which is every table in every schema, and hardcode `id=eq.:id` as the filter
   * for PATCH and DELETE. So it documented `/rest/v1/<name>` for tables REST
   * answers 404 or 403 on, and identity filters on a column that may not exist.
   * Here the list is the same one the router serves and the key is the real one,
   * composite keys included.
   */
  async listResources(): Promise<RestResource[]> {
    const catalog = await getCatalog();
    return catalog
      .tablesIn(REST_SCHEMA)
      .filter(isRestExposable)
      .filter(table => !toRestModel(table).system)
      .map(table => ({
        name: table.name,
        path: `/rest/v1/${table.name}`,
        primaryKey: table.primaryKey.slice(),
        rlsEnabled: table.rlsEnabled,
        columns: table.columns.map(column => ({
          name: column.name,
          type: column.formattedType,
          nullable: column.nullable,
          hasDefault: column.hasDefault,
          isPrimaryKey: column.isPk,
          isGenerated: column.isGenerated,
        })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Rows only. The full response envelope is `handleSelect`. */
  async handleGet(modelName: string, query: Record<string, unknown>, user?: RlsUser): Promise<any[]> {
    return (await this.handleSelect(modelName, query, user)).rows;
  }

  /**
   * The read path: exact counts, relational embedding, and the CSV, single-object
   * and plan response modes.
   *
   * Everything runs in ONE `withRlsTx` transaction under the caller's role: the
   * row query, every embedded LATERAL subquery inside it, and the count query
   * when the count cannot be produced by a window function. A count computed on
   * a second connection could disagree with the rows because a different
   * snapshot (and, worse, a different role) would apply to it.
   */
  async handleSelect(
    modelName: string,
    query: Record<string, unknown>,
    user?: RlsUser,
    options: ReadOptions = {},
  ): Promise<ReadResult> {
    const target = await targetOrThrow(modelName);
    const parsed = parseQuery(query);
    const prefer = options.prefer ?? DEFAULT_PREFER;

    const built = await this.buildRead(target, parsed);
    const { ctx, joins, whereSql, orderSql } = built;
    const where = whereSql ? ` WHERE ${whereSql}` : '';

    // parseQuery caps take at 1000 and rejects anything that is not a
    // non-negative integer, so these are safe to inline (LIMIT/OFFSET cannot be
    // bound as parameters here). The console-tunable api.rest.maxRows tightens
    // that ceiling further; when the setting is unavailable we fall back to the
    // parser's hard 1000 cap.
    const restCfg = await this.di.SettingsService?.get<{ maxRows: number }>('api.rest').catch(() => null);
    const maxRows = restCfg?.maxRows ?? 1000;
    // `?limit`/`?offset` win over the `Range` header when both are present,
    // which is how PostgREST resolves the same conflict.
    const requestedTake = parsed.take ?? options.range?.limit;
    const requestedSkip = parsed.skip ?? options.range?.offset;
    // An unbounded select returns up to `maxRows`, which is what PostgREST does
    // with `db-max-rows` and therefore what a Supabase app was built against.
    // A smaller default would silently truncate ported list pages. Tighten the
    // ceiling with `api.rest.maxRows`: one number governs the default and cap.
    const limit = Math.min(requestedTake ?? maxRows, maxRows);
    const offset = requestedSkip ?? 0;

    const relation = `${relationSql(target.model)}${ctx.alias ? ` ${quoteIdent(ctx.alias)}` : ''}`;
    // The exact count is a window function on the SAME statement, so it is one
    // round trip and cannot observe a different snapshot than the rows.
    const countColumn =
      prefer.count === 'exact' && !options.head ? `, count(*) OVER () AS ${quoteIdent(COUNT_COLUMN)}` : '';
    const rowSql =
      `SELECT ${built.columns}${countColumn} FROM ${relation}${joins}${where}` +
      `${orderSql ? ` ORDER BY ${orderSql}` : ''} LIMIT ${limit} OFFSET ${offset}`;

    const result = await this.withRls(
      target.model,
      user,
      async (client) => {
        if (options.explain) {
          const plan = await client.query(`EXPLAIN (FORMAT JSON) ${rowSql}`, ctx.params.values);
          return { rows: [], count: null, plan: plan.rows?.[0]?.['QUERY PLAN'] ?? plan.rows };
        }

        let rows: any[] = [];
        let count: number | null = null;

        if (!options.head) {
          const response = await client.query(rowSql, ctx.params.values);
          rows = response.rows;
          if (prefer.count === 'exact') {
            // An empty page is ambiguous: the window function emits no row, and
            // the filter may still match plenty of rows that this offset walked
            // past. Only offset 0 proves a total of zero; past the last page the
            // count below answers it, or `count=exact` lies about the total and
            // the client computes the wrong number of pages.
            count = rows.length ? Number(rows[0][COUNT_COLUMN]) : offset === 0 ? 0 : null;
            for (const row of rows) delete row[COUNT_COLUMN];
          }
        }

        if (prefer.count && count === null) {
          count = await this.countRows(client, target, prefer.count, {
            relation,
            joins,
            where,
            params: ctx.params.values,
          });
        }

        return { rows, count, plan: undefined as unknown };
      },
      built.embeddedTables,
    );

    const masked = result.rows.map((row: any) => maskRow(row));
    return {
      rows: masked,
      count: result.count,
      offset,
      contentRange: contentRange(offset, masked.length, result.count),
      ...(result.plan === undefined ? {} : { plan: result.plan }),
    };
  }

  async handlePost(
    modelName: string,
    body: any,
    user?: RlsUser,
    options: WriteOptions = {},
  ): Promise<any[]> {
    const target = await targetOrThrow(modelName);
    const prefer = options.prefer ?? DEFAULT_PREFER;
    const rows: Array<Record<string, any>> = Array.isArray(body) ? body : [body ?? {}];
    if (!rows.length) return [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new HttpException('Insert body must be an object or an array of objects.', 400);
      }
      assertKnownDataFields(target, row);
    }

    const insert = this.buildInsert(target, rows, prefer, options.query ?? {});

    const written = await this.runWrite(() =>
      this.withRls(target.model, user, async (client) => {
        const { response, changes } = await captureWrite(client, relationSql(target.model),
          () => client.query(insert.sql, insert.params));
        const created = changes.filter(change => change.action === 'created').map(change => maskRow(change.row));
        const updated = changes.filter(change => change.action === 'updated').map(change => maskRow(change.row));
        if (created.length) await this.di.RealtimeOutboxService.enqueue(client, target.model, 'created', created);
        if (updated.length) await this.di.RealtimeOutboxService.enqueue(client, target.model, 'updated', updated);
        const rows = response.rows.map(row => maskRow(row));
        this.enforceWriteBudget(prefer, rows, response.rowCount ?? 0);
        return { rows, created, updated };
      }, [], options.tx),
    );
    if (written.rolledBack) return written.rows;
    const { rows: result, created, updated } = written.value!;
    if (created.length) this.dispatchWebhooks(target.model, 'created', created, options.afterCommit);
    if (updated.length) this.dispatchWebhooks(target.model, 'updated', updated, options.afterCommit);
    return result;
  }

  async handlePatch(
    modelName: string,
    query: Record<string, unknown>,
    body: any,
    user?: RlsUser,
    options: WriteOptions = {},
  ): Promise<any> {
    const target = await targetOrThrow(modelName);
    const parsed = parseQuery(query);
    const prefer = options.prefer ?? DEFAULT_PREFER;
    const data = body ?? {};
    assertPatchBody(target, data);
    assertScopedMutation(parsed.filter, user);

    // The SET values are bound first, so the filter's placeholders continue from
    // where they stop. One list, one numbering, no manual offset arithmetic.
    const ctx = createContext(target.table, createParams(Object.values(data)));
    const dataKeys = Object.keys(data);
    const sets = dataKeys.map((key, index) => `${quoteIdent(key)} = $${index + 1}`).join(', ');
    const whereSql = parsed.filter ? filterToSql(parsed.filter, ctx).sql : '';
    const sql = `UPDATE ${relationSql(target.model)} SET ${sets}${
      whereSql ? ` WHERE ${whereSql}` : ''
    }${this.writeReturning(prefer, parsed, ctx)}`;

    const written = await this.runWrite(() =>
      this.withRls(target.model, user, async (client) => {
        const { response, changes } = await captureWrite(client, relationSql(target.model),
          () => client.query(sql, ctx.params.values));
        // Moving a row between partitions fires DELETE + INSERT row triggers.
        // An UPDATE event describes its new image, never the deleted old image.
        const payloads = changes.filter(change => change.action !== 'deleted').map(change => maskRow(change.row));
        await this.di.RealtimeOutboxService.enqueue(client, target.model, 'updated', payloads);
        const rows = response.rows.map(row => maskRow(row));
        this.enforceWriteBudget(prefer, rows, response.rowCount ?? 0);
        return { rows, payloads, count: response.rowCount ?? 0 };
      }, [], options.tx),
    );
    if (written.rolledBack) return prefer.return === 'representation' ? written.rows : [];

    const { rows, payloads, count } = written.value!;
    await this.assertMutationAffectedRows(target, 'update', count, parsed.filter, user);
    this.dispatchWebhooks(target.model, 'updated', payloads, options.afterCommit);
    return rows;
  }

  async handleDelete(
    modelName: string,
    query: Record<string, unknown>,
    user?: RlsUser,
    options: WriteOptions = {},
  ): Promise<any> {
    const target = await targetOrThrow(modelName);
    const parsed = parseQuery(query);
    const prefer = options.prefer ?? DEFAULT_PREFER;
    assertScopedMutation(parsed.filter, user);

    const ctx = createContext(target.table, createParams());
    const whereSql = parsed.filter ? filterToSql(parsed.filter, ctx).sql : '';
    const filterSql = whereSql ? ` WHERE ${whereSql}` : '';
    const params = ctx.params.values;
    const candidates: Array<{ id: unknown; _restXmin: string }> = await this.withRls(
      target.model,
      user,
      (client) =>
        client
          .query(`SELECT "id", xmin::text AS "_restXmin" FROM ${relationSql(target.model)}${filterSql}`, params)
          .then((r: any) => r.rows),
      [],
      options.tx,
    );
    await this.assertMutationAffectedRows(target, 'delete', candidates.length, parsed.filter, user);

    // Bind the delete to the exact row versions whose audience was checked.
    // If a row changes concurrently, its xmin changes and no stale visibility
    // proof can authorize the deletion event.
    const audience = await this.di.RealtimeBroadcastService.captureDeleteAudience(
      target.model,
      candidates.map(row => row.id)
    );
    const xminParam = ctx.params.push(candidates.map(row => row._restXmin));
    const stableFilterSql = whereSql ? `(${whereSql}) AND ` : '';
    const deleteSql =
      `DELETE FROM ${relationSql(target.model)} WHERE ${stableFilterSql}` +
      `xmin::text = ANY(${xminParam}::text[])${this.writeReturning(prefer, parsed, ctx)}`;
    const written = await this.runWrite(() =>
      this.withRls(target.model, user, async (client) => {
        const { response, changes } = await captureWrite(client, relationSql(target.model),
          () => client.query(deleteSql, params));
        const payloads = changes.filter(change => change.action === 'deleted').map(change => ({ id: change.row.id }));
        await this.di.RealtimeOutboxService.enqueue(
          client,
          target.model,
          'deleted',
          payloads,
          audience,
        );
        const rows = response.rows.map(row => maskRow(row));
        this.enforceWriteBudget(prefer, rows, response.rowCount ?? 0);
        return { rows, payloads, count: response.rowCount ?? 0 };
      }, [], options.tx),
    );
    if (written.rolledBack) return prefer.return === 'representation' ? written.rows : [];

    const { rows, payloads, count } = written.value!;
    await this.assertMutationAffectedRows(target, 'delete', count, parsed.filter, user);
    this.dispatchWebhooks(
      target.model,
      'deleted',
      payloads,
      options.afterCommit,
    );
    return prefer.return === 'representation' ? rows : [];
  }

  /**
   * Several writes, one transaction, all or nothing.
   *
   * supabase-js has no equivalent, and the workaround people write instead is a
   * sequence of awaited calls with a `try` around it, which is not a rollback:
   * the writes that already committed stay committed, and the application is
   * left holding half a change it cannot undo.
   *
   * Reads are not accepted here. A batch exists to make writes atomic, and
   * mixing a read in invites the expectation that the rows it returns reflect
   * the writes around it, which would make the response shape depend on
   * statement order in a way nobody could rely on.
   *
   * The whole batch runs as ONE caller: impersonation and keys are resolved per
   * request, so there is no way for two operations in one batch to run as
   * different users.
   */
  async handleBatch(
    operations: BatchOperation[],
    user?: RlsUser,
    options: { prefer?: Preferences } = {},
  ): Promise<any[][]> {
    const prefer = options.prefer ?? parsePrefer(undefined, 'representation');
    if (!Array.isArray(operations) || !operations.length) {
      throw new HttpException('A batch needs at least one operation.', 400);
    }
    if (operations.length > MAX_BATCH_OPERATIONS) {
      throw new HttpException(
        `A batch is limited to ${MAX_BATCH_OPERATIONS} operations, received ${operations.length}.`,
        400,
      );
    }
    for (const operation of operations) {
      if (!operation?.model || typeof operation.model !== 'string') {
        throw new HttpException('Every batch operation needs a `model`.', 400);
      }
      if (!BATCH_METHODS.has(operation.method)) {
        throw new HttpException(
          `Batch operations are writes only: expected one of ${[...BATCH_METHODS].join(', ')}, `
            + `received '${String(operation.method)}' on ${operation.model}.`,
          400,
        );
      }
    }

    // One transaction for the whole batch. A failure anywhere throws out of the
    // callback, which rolls back every statement AND every realtime outbox row
    // written alongside them, so nothing is announced that did not happen.
    const afterCommit: Array<() => void> = [];
    const written = await this.runWrite(() => this.di.RlsPool.withRlsTx(rlsContextFor(user), async (tx) => {
      const results: any[][] = [];
      for (const operation of operations) {
        const inner: WriteOptions = {
          prefer: { ...prefer, txRollback: false }, query: operation.query ?? {}, tx, afterCommit,
        };
        if (operation.method === 'POST') {
          results.push(await this.handlePost(operation.model, operation.body, user, inner));
        } else if (operation.method === 'PATCH') {
          results.push(
            await this.handlePatch(operation.model, operation.query ?? {}, operation.body, user, inner),
          );
        } else {
          results.push(await this.handleDelete(operation.model, operation.query ?? {}, user, inner));
        }
      }
      if (prefer.txRollback) throw new RollbackRequested(results);
      return results;
    }));
    if (written.rolledBack) return written.rows;
    for (const dispatch of afterCommit) dispatch();
    return written.value!;
  }

  // ── 2.8 `/rpc/:fn` ────────────────────────────────────────────────────────

  /**
   * Call a function by name, inside the caller's RLS transaction.
   *
   * `options.schema` is the schema the request's profile header named, or
   * nothing for `public`. It must be one `resolveRpcSchema` exposes: `public`,
   * or a feature schema such as `pgmq_public` while that feature is on.
   *
   * The security crux of this route is `SECURITY DEFINER`. Such a function runs
   * with the privileges of its OWNER rather than of the caller, and a table's
   * owner is exempt from that table's row-level security unless the table is
   * declared `FORCE ROW LEVEL SECURITY`. Publishing one at `/rest/v1/rpc/<name>`
   * would therefore hand an anonymous HTTP caller a fully privileged, policy-free
   * path into the database, which is precisely the property the rest of this
   * service exists to prevent. Definer functions are refused unless an operator
   * has named them in the allowlist, and the refusal is a 403 that says why.
   *
   * `GET` additionally requires a non-volatile function, exactly as PostgREST
   * does: a read-only verb must not be able to write.
   */
  async handleRpc(
    fnName: string,
    args: Record<string, unknown>,
    user?: RlsUser,
    options: { method?: 'GET' | 'POST'; prefer?: Preferences; schema?: string } = {},
  ): Promise<{ rows: any[]; single: boolean; scalar: boolean }> {
    const prefer = options.prefer ?? parsePrefer(undefined, 'representation');
    const catalog = await getCatalog();
    const schema = resolveRpcSchema(catalog, options.schema);
    const overloads = catalog.functionsNamed(schema, fnName);
    if (!overloads.length) {
      throw new HttpException(`Could not find the function ${schema}.${fnName} in the schema cache.`, 404, 'PGRST202', {
        expose: true,
      });
    }

    const allowlist = await this.securityDefinerAllowlist();
    const supplied = Object.keys(args ?? {});
    const fn = pickOverload(fnName, overloads, supplied, prefer.singleObjectParams);

    if (fn.securityDefiner && !allowlist.has(fn.name)) {
      throw new HttpException(
        `${schema}.${fnName} is SECURITY DEFINER and is not exposed over REST. A definer function runs as its ` +
          `owner and bypasses row-level security, so it must be allowlisted explicitly before it can be called.`,
        403,
        'PGRST203',
        { expose: true },
      );
    }

    if (options.method === 'GET' && fn.volatility === 'v') {
      throw new HttpException(
        `${schema}.${fnName} is VOLATILE and cannot be called with GET. Use POST.`,
        405,
        'PGRST101',
        { expose: true },
      );
    }

    const params = createParams();
    const callArgs = prefer.singleObjectParams
      ? bindSingleObjectArg(fn, args, params)
      : bindNamedArgs(fn, args, params);
    const call = `${quoteIdent(schema)}.${quoteIdent(fn.name)}(${callArgs})`;

    // A set-returning or table-returning function is selected FROM, so each
    // output row becomes a response row. Anything else is a single value.
    const setLike = fn.returnsSet || Boolean(fn.returnRelation) || fn.returnTypeKind === 'c';
    const sql = setLike ? `SELECT * FROM ${call}` : `SELECT ${call} AS "value"`;

    const rows: any[] = await this.di.RlsPool.withRlsTx(rlsContextFor(user), async (client) => {
      const response = await client.query(sql, params.values);
      return response.rows;
    });

    if (setLike) {
      return { rows: rows.map((row: any) => maskRow(row)), single: !fn.returnsSet, scalar: false };
    }
    return { rows: rows.map((row: any) => maskRow(row.value)), single: true, scalar: true };
  }

  /**
   * Names of `SECURITY DEFINER` functions an operator has deliberately exposed.
   *
   * Read from the `api.rest` settings group, which seeds itself from
   * `REST_RPC_SECURITY_DEFINER` while no row has been saved. Empty by default:
   * exposing a definer function is always an explicit act.
   *
   * The direct env read is the fallback for the one case the settings group
   * cannot cover: SettingsService being unavailable, which is why the call is
   * caught rather than allowed to throw. An empty stored value is NOT that
   * case: `??` passes '' straight through, so clearing the list in Studio
   * clears it for real instead of silently reverting to the environment.
   *
   * Names are compared against `pg_proc.proname` verbatim, with no case folding:
   * an unquoted `CREATE FUNCTION my_fn` is stored as `my_fn`, but a quoted
   * `CREATE FUNCTION "MyFn"` is stored as `MyFn`, and folding here would make
   * the second impossible to allowlist.
   */
  private async securityDefinerAllowlist(): Promise<Set<string>> {
    const cfg = await this.di.SettingsService?.get<{ rpcSecurityDefiner?: string[] | string }>('api.rest').catch(
      () => null,
    );
    const raw = cfg?.rpcSecurityDefiner ?? process.env.REST_RPC_SECURITY_DEFINER ?? '';
    const names = Array.isArray(raw) ? raw : String(raw).split(',');
    return new Set(names.map(name => name.trim()).filter(Boolean));
  }

  // ── Read helpers ──────────────────────────────────────────────────────────

  /**
   * Compile the projection, the LATERAL joins, the filter and the order for a
   * read, and report every table an embed reached so the caller can gate them.
   */
  private async buildRead(
    target: RestTarget,
    parsed: ParsedQuery,
  ): Promise<{
    ctx: CompileContext;
    columns: string;
    joins: string;
    whereSql: string;
    orderSql: string;
    embeddedTables: string[];
  }> {
    const hasEmbeds = Boolean(parsed.select?.some(item => item.kind === 'relation'));
    // The parent relation is only aliased when something has to correlate with
    // it, so a plain read emits exactly the SQL it always did.
    const alias = hasEmbeds ? target.table.name : undefined;
    const embed = hasEmbeds
      ? createEmbedScope(await getCatalog(), table => assertEmbeddable(table))
      : undefined;

    // One shared parameter list per statement, so the compiler's placeholder
    // numbering is contiguous across the projection (including every embedded
    // subquery), the filter and the order.
    const ctx = createContext(target.table, createParams(), alias, embed);
    // Every column named in ?select, ?order and the filter tree is resolved
    // against the catalog inside the compiler, so the projection is an allowlist
    // and unrequested columns never reach the wire.
    const columns = selectToSql(parsed.select, ctx);
    const whereSql = parsed.filter ? filterToSql(parsed.filter, ctx).sql : '';
    const orderSql = orderToSql(parsed.order, ctx);

    return {
      ctx,
      columns,
      joins: ctx.joins.length ? ` ${ctx.joins.join(' ')}` : '',
      whereSql,
      orderSql,
      embeddedTables: (embed?.reached ?? []).map(table => table.name),
    };
  }

  /**
   * The count for `Prefer: count=planned|estimated`, and for a HEAD request.
   *
   * All three run on the transaction client the rows were read on, so they see
   * the same snapshot under the same role.
   */
  private async countRows(
    client: PoolClient,
    target: RestTarget,
    mode: CountMode,
    query: { relation: string; joins: string; where: string; params: unknown[] },
  ): Promise<number> {
    const inner = `SELECT 1 FROM ${query.relation}${query.joins}${query.where}`;

    if (mode === 'exact') {
      const response = await client.query(`SELECT count(*)::bigint AS "count" FROM (${inner}) s`, query.params);
      return Number(response.rows[0]?.count ?? 0);
    }

    if (mode === 'planned') {
      const response = await client.query(`EXPLAIN (FORMAT JSON) ${inner}`, query.params);
      const plan = response.rows?.[0]?.['QUERY PLAN'];
      const parsed = typeof plan === 'string' ? JSON.parse(plan) : plan;
      return Number(parsed?.[0]?.Plan?.['Plan Rows'] ?? 0);
    }

    // `estimated`: whole-table statistics, ignoring the filter. reltuples is -1
    // on a table that has never been analysed, in which case there is nothing to
    // estimate from and an exact count is the honest answer.
    const response = await client.query(
      `SELECT c.reltuples::bigint AS "count"
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [target.model.schema, target.model.dbName],
    );
    const estimate = Number(response.rows[0]?.count ?? -1);
    if (estimate >= 0) return estimate;
    return this.countRows(client, target, 'exact', query);
  }

  /** Only caller-requested columns participate in PostgreSQL SELECT/RLS checks. */
  private writeReturning(prefer: Preferences, parsed: ParsedQuery, ctx: CompileContext): string {
    return prefer.return === 'representation' ? ` RETURNING ${selectToSql(parsed.select, ctx)}` : '';
  }

  // ── Write helpers ─────────────────────────────────────────────────────────

  /**
   * Build the INSERT, including the `ON CONFLICT` clause that makes 2.6's upsert
   * a real upsert rather than an insert that fails on a duplicate.
   *
   * Rows may declare different subsets of columns; a column a row omits is
   * written as `DEFAULT` so the database applies its own default rather than a
   * NULL this layer invented.
   */
  private buildInsert(
    target: RestTarget,
    rows: Array<Record<string, any>>,
    prefer: Preferences,
    query: Record<string, unknown>,
  ): { sql: string; params: unknown[] } {
    const relation = relationSql(target.model);
    const columns: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
    }

    const upsert = prefer.resolution !== null;
    const conflict = upsert ? conflictTarget(target, query) : null;
    const params = createParams();
    const parsed = parseQuery(query);

    if (!columns.length) {
      if (rows.length > 1) {
        throw new HttpException('Cannot insert several rows that all specify no columns.', 400);
      }
      return { sql: `INSERT INTO ${relation} DEFAULT VALUES${this.writeReturning(prefer, parsed, createContext(target.table, params))}`, params: params.values };
    }

    const tuples = rows.map(
      row =>
        `(${columns
          .map(column =>
            Object.prototype.hasOwnProperty.call(row, column) ? params.push(row[column]) : 'DEFAULT',
          )
          .join(', ')})`,
    );

    let onConflict = '';
    if (conflict) {
      const target_ = conflict.map(quoteIdent).join(', ');
      // Every column that is not part of the conflict key is refreshed from the
      // proposed row. When there is nothing left to update the statement would be
      // invalid, so it degrades to DO NOTHING.
      const updatable = columns.filter(column => !conflict.includes(column));
      onConflict =
        prefer.resolution === 'ignore-duplicates' || !updatable.length
          ? ` ON CONFLICT (${target_}) DO NOTHING`
          : ` ON CONFLICT (${target_}) DO UPDATE SET ${updatable
              .map(column => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`)
              .join(', ')}`;
    }

    const sql =
      `INSERT INTO ${relation} (${columns.map(quoteIdent).join(', ')}) ` +
      `VALUES ${tuples.join(', ')}${onConflict}${this.writeReturning(prefer, parsed, createContext(target.table, params))}`;
    return { sql, params: params.values };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async withRls<T>(
    model: RestModelMeta,
    user: RlsUser | undefined,
    work: (client: PoolClient) => Promise<T>,
    embeddedTables: string[] = [],
    /** Join this transaction instead of opening one. See `WriteOptions.tx`. */
    existing?: PoolClient,
  ): Promise<T> {
    // Fail closed: the table, and every table an embed reaches, must report RLS
    // on, or the request stops before any data SQL. An embedded relation must
    // not become a hole around that rule: its rows are returned to the caller
    // just like the parent's are.
    const tables = [model.dbName, ...embeddedTables];
    const run = async (client: PoolClient, rlsEnabled: ReadonlySet<string>) => {
      if (!rlsEnabled.has(model.dbName)) {
        throw new HttpException(
          `Table '${model.dbName}' is not exposed because row-level security is not enabled.`,
          403,
        );
      }
      for (const table of embeddedTables) {
        if (!rlsEnabled.has(table)) {
          throw new HttpException(
            `Table '${table}' cannot be embedded because row-level security is not enabled on it.`,
            403,
          );
        }
      }

      try {
        return await work(client);
      } catch (error: any) {
        // `42883` is "operator/function does not exist", which on this path can
        // only mean the caller applied an operator to a column type it does not
        // support (`cs` on a scalar, `fts` on an integer). That is a malformed
        // request, not a server fault, so it must not surface as a 500.
        if (error?.code === '42883') {
          throw new HttpException(
            `Operator not supported for this column type on ${model.dbName}: ${error.message}`,
            400,
            'PGRST100',
            { expose: true },
          );
        }
        throw error;
      }
    };

    // A transaction somebody else opened has not asked the gate for these
    // tables, so it is asked here; a new one answers it as it opens.
    return existing
      ? run(existing, await rlsEnabledTables(existing, tables))
      : this.di.RlsPool.withRlsTx(rlsContextFor(user), run, { rlsGate: tables });
  }

  private dispatchWebhooks(
    model: RestModelMeta,
    action: 'created' | 'updated' | 'deleted',
    rows: unknown[],
    afterCommit?: Array<() => void>,
  ): void {
    if (!rows.length) return;
    if (afterCommit) {
      afterCommit.push(() => this.dispatchWebhooks(model, action, rows));
      return;
    }
    try {
      const dispatch = this.di.EventDispatcherService?.dispatch?.(model.model, action, rows);
      if (dispatch) {
        void Promise.resolve(dispatch).catch(error => {
          logActivity('error', 'webhook', `[realtime] webhook dispatch failed: ${errorMessage(error)}`);
        });
      }
    } catch (error) {
      logActivity('error', 'webhook', `[realtime] webhook dispatch failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Run a write, turning a `Prefer: tx=rollback` abort back into a result.
   *
   * `rolledBack` is what every caller branches on: the rows are reportable, and
   * nothing durable happened, so no webhook and no realtime event may follow.
   */
  private async runWrite<T>(work: () => Promise<T>): Promise<{
    value: T | null;
    rolledBack: boolean;
    rows: any[];
  }> {
    try {
      return { value: await work(), rolledBack: false, rows: [] };
    } catch (error) {
      if (error instanceof RollbackRequested) return { value: null, rolledBack: true, rows: error.rows };
      throw error;
    }
  }

  /**
   * `Prefer: max-affected` and `Prefer: tx=rollback`, applied from INSIDE the
   * write's transaction, where throwing rolls it back.
   *
   * Checking after the statement and before the commit is what makes the guard
   * real: the count is exact, and the undo is free.
   */
  private enforceWriteBudget(prefer: Preferences, rows: any[], count = rows.length): void {
    if (prefer.maxAffected !== null && count > prefer.maxAffected) {
      throw new HttpException(
        `The query affects ${count} rows, more than the ${prefer.maxAffected} allowed by `
          + 'Prefer: max-affected. Nothing was written.',
        400,
        'PGRST124',
        { expose: true },
      );
    }
    if (prefer.txRollback) throw new RollbackRequested(rows);
  }

  private async assertMutationAffectedRows(
    target: RestTarget,
    operation: 'update' | 'delete',
    affectedRows: number,
    requestedFilter: Filter | null,
    user?: RlsUser
  ): Promise<void> {
    if (affectedRows > 0) return;

    // Do not let public callers distinguish a missing row from one hidden by
    // RLS. Admins retain the more precise diagnostic for operational tooling.
    if (user?.role !== 'ADMIN') {
      throw new HttpException(`No rows match the ${operation.toUpperCase()} filter on ${target.model.model}.`, 404);
    }

    const existsIgnoringRls = await this.rowExistsIgnoringPolicy(target, requestedFilter);
    if (!existsIgnoringRls) {
      throw new HttpException(`No rows match the ${operation.toUpperCase()} filter on ${target.model.model}.`, 404);
    }

    throw new HttpException(
      `No rows were ${operation === 'update' ? 'updated' : 'deleted'} because RLS policy excludes the matching row(s).`,
      403
    );
  }

  /**
   * Control-plane existence probe that deliberately bypasses RLS: it runs on the
   * Prisma (owner) connection, never on RlsPool, so an admin can be told the
   * difference between "no such row" and "a policy hid it". Only ever reached
   * from the `user?.role === 'ADMIN'` branch above.
   */
  private async rowExistsIgnoringPolicy(target: RestTarget, filter: Filter | null): Promise<boolean> {
    const ctx = createContext(target.table, createParams());
    const whereSql = filter ? filterToSql(filter, ctx).sql : '';
    const sql = `SELECT EXISTS (SELECT 1 FROM ${relationSql(target.model)}${
      whereSql ? ` WHERE ${whereSql}` : ''
    } LIMIT 1) AS "exists"`;
    const rows = await this.di.prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(sql, ...ctx.params.values);
    return Boolean(rows[0]?.exists);
  }
}
