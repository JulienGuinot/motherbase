import BaseContext from '../../context/base-context';
import { HttpException } from '../../exceptions/http-exception';
import { formatSqlError } from '../../lib/pg-error';
import { invalidateCatalog } from '../rest-api/catalog';
import { execDdl, type DdlExecutor } from './schema-ddl';

/**
 * Supabase Queues, on the pgmq extension the Motherbase Postgres image ships.
 *
 * The model is Supabase's, piece for piece:
 *   - a queue is `pgmq.q_<name>` plus its archive `pgmq.a_<name>`, and every
 *     operation is one of pgmq's own functions, so a queue made here is exactly
 *     the queue `select pgmq.send(...)` would find;
 *   - "Expose queues via the API" creates the `pgmq_public` schema of thin
 *     SECURITY INVOKER wrappers (send, send_batch, read, pop, archive, delete)
 *     that `client.schema('pgmq_public').rpc(...)` reaches. The REST layer
 *     serves that schema only while it exists (see RestApiService.handleRpc);
 *   - invoker wrappers mean the caller's own privileges decide: anon and
 *     authenticated can do nothing to a queue until they are granted it here,
 *     and a queue created with RLS on then filters them through its policies.
 */

export const QUEUE_TYPES = ['basic', 'unlogged', 'partitioned'] as const;
export type QueueType = (typeof QUEUE_TYPES)[number];

/** The roles a queue's permissions are granted to. service_role always has everything. */
export const QUEUE_ROLES = ['anon', 'authenticated'] as const;
export type QueueRole = (typeof QUEUE_ROLES)[number];

export const QUEUE_PRIVILEGES = ['select', 'insert', 'update', 'delete'] as const;
export type QueuePrivilege = (typeof QUEUE_PRIVILEGES)[number];
export type QueuePrivileges = Record<QueuePrivilege, boolean>;

/**
 * pgmq refuses names over 47 characters (its partitioned template table has to
 * fit in 63) and lowercases the rest. Accepting only what it would store
 * unchanged means the name in the URL is always the name of the table.
 */
export const QUEUE_NAME_RE = /^[a-z_][a-z0-9_]{0,46}$/;

export interface QueueStatus {
  /** pgmq's control file is present in this database image. */
  available: boolean;
  installed: boolean;
  version: string | null;
  /** The `pgmq_public` schema exists, so the queues are reachable over /rest/v1/rpc. */
  exposed: boolean;
  /** Partitioned queues need pg_partman, which the image does not ship by default. */
  partitionedAvailable: boolean;
}

export interface QueueInfo {
  name: string;
  type: QueueType;
  createdAt: string;
  rlsEnabled: boolean;
  /** Messages in the queue, visible or not. */
  length: number;
  /** Messages a `read` would return right now. */
  visibleLength: number;
  newestMsgAgeSec: number | null;
  oldestMsgAgeSec: number | null;
  /** Every message ever sent to this queue. */
  totalMessages: number;
}

/** A pgmq message, in pgmq's own record shape: the one `pgmq_public.read` returns too. */
export interface QueueMessage {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: unknown;
  headers: unknown;
  archived_at?: string;
}

export interface QueuePermissions {
  rlsEnabled: boolean;
  roles: Record<QueueRole, QueuePrivileges>;
}

type Row = Record<string, unknown>;

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const num = (value: unknown): number => Number(value ?? 0);
const numOrNull = (value: unknown): number | null => (value == null ? null : Number(value));

export function assertQueueName(name: unknown): string {
  if (typeof name !== 'string' || !QUEUE_NAME_RE.test(name)) {
    throw new HttpException(
      'Queue names are lowercase letters, digits and underscores, start with a letter or underscore, and are at most 47 characters.',
      400,
    );
  }
  return name;
}

/** `pgmq."q_<name>"`. Safe to interpolate: the name has passed assertQueueName. */
const queueTable = (name: string) => `pgmq."q_${name}"`;
const archiveTable = (name: string) => `pgmq."a_${name}"`;

/** The wrappers `pgmq_public` exposes, verbatim from Supabase's own definitions. */
const PGMQ_PUBLIC_FUNCTIONS = [
  `CREATE OR REPLACE FUNCTION pgmq_public.pop(queue_name text)
     RETURNS SETOF pgmq.message_record LANGUAGE plpgsql SET search_path = '' AS $$
     BEGIN RETURN QUERY SELECT * FROM pgmq.pop(queue_name := queue_name); END; $$`,
  `CREATE OR REPLACE FUNCTION pgmq_public.send(queue_name text, message jsonb, sleep_seconds integer DEFAULT 0)
     RETURNS SETOF bigint LANGUAGE plpgsql SET search_path = '' AS $$
     BEGIN RETURN QUERY SELECT * FROM pgmq.send(queue_name := queue_name, msg := message, delay := sleep_seconds); END; $$`,
  `CREATE OR REPLACE FUNCTION pgmq_public.send_batch(queue_name text, messages jsonb[], sleep_seconds integer DEFAULT 0)
     RETURNS SETOF bigint LANGUAGE plpgsql SET search_path = '' AS $$
     BEGIN RETURN QUERY SELECT * FROM pgmq.send_batch(queue_name := queue_name, msgs := messages, delay := sleep_seconds); END; $$`,
  `CREATE OR REPLACE FUNCTION pgmq_public.archive(queue_name text, message_id bigint)
     RETURNS boolean LANGUAGE plpgsql SET search_path = '' AS $$
     BEGIN RETURN pgmq.archive(queue_name := queue_name, msg_id := message_id); END; $$`,
  `CREATE OR REPLACE FUNCTION pgmq_public.delete(queue_name text, message_id bigint)
     RETURNS boolean LANGUAGE plpgsql SET search_path = '' AS $$
     BEGIN RETURN pgmq.delete(queue_name := queue_name, msg_id := message_id); END; $$`,
  `CREATE OR REPLACE FUNCTION pgmq_public.read(queue_name text, sleep_seconds integer, n integer)
     RETURNS SETOF pgmq.message_record LANGUAGE plpgsql SET search_path = '' AS $$
     BEGIN RETURN QUERY SELECT * FROM pgmq.read(queue_name := queue_name, vt := sleep_seconds, qty := n); END; $$`,
];

/**
 * Statements that expose (or stop exposing) the queues over the API.
 *
 * EXECUTE is revoked from PUBLIC first because Postgres grants it to everyone
 * by default: the grant below is then the whole list of who may call them.
 * USAGE on `pgmq` is what lets an invoker wrapper reach the queue tables at
 * all; the tables themselves stay closed until a queue's permissions open them.
 */
export function exposeStatements(enabled: boolean): string[] {
  if (!enabled) {
    return [
      'DROP SCHEMA IF EXISTS pgmq_public CASCADE',
      'REVOKE USAGE ON SCHEMA pgmq FROM anon, authenticated',
    ];
  }
  return [
    'CREATE SCHEMA IF NOT EXISTS pgmq_public',
    ...PGMQ_PUBLIC_FUNCTIONS,
    'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq_public FROM PUBLIC',
    'GRANT USAGE ON SCHEMA pgmq_public TO anon, authenticated, service_role',
    'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq_public TO anon, authenticated, service_role',
    'GRANT USAGE ON SCHEMA pgmq TO anon, authenticated, service_role',
    'GRANT ALL ON ALL TABLES IN SCHEMA pgmq TO service_role',
    'GRANT ALL ON ALL SEQUENCES IN SCHEMA pgmq TO service_role',
  ];
}

/**
 * GRANT and REVOKE statements that make `role`'s privileges on a queue equal
 * `wanted`. Applied to the archive too: `archive` moves a row from one table to
 * the other, and a role that can delete from the queue but not insert into the
 * archive would get a permission error halfway through.
 */
export function permissionStatements(name: string, role: QueueRole, wanted: QueuePrivileges): string[] {
  const grant = QUEUE_PRIVILEGES.filter(p => wanted[p]).map(p => p.toUpperCase());
  const revoke = QUEUE_PRIVILEGES.filter(p => !wanted[p]).map(p => p.toUpperCase());
  const tables = `${queueTable(name)}, ${archiveTable(name)}`;
  return [
    ...(grant.length ? [`GRANT ${grant.join(', ')} ON ${tables} TO ${role}`] : []),
    ...(revoke.length ? [`REVOKE ${revoke.join(', ')} ON ${tables} FROM ${role}`] : []),
  ];
}

function toQueue(row: Row): QueueInfo {
  return {
    name: String(row.name),
    type: row.is_partitioned ? 'partitioned' : row.is_unlogged ? 'unlogged' : 'basic',
    createdAt: iso(row.created_at),
    rlsEnabled: Boolean(row.rls_enabled),
    length: num(row.queue_length),
    visibleLength: num(row.queue_visible_length),
    newestMsgAgeSec: numOrNull(row.newest_msg_age_sec),
    oldestMsgAgeSec: numOrNull(row.oldest_msg_age_sec),
    totalMessages: num(row.total_messages),
  };
}

function toMessage(row: Row): QueueMessage {
  return {
    msg_id: num(row.msg_id),
    read_ct: num(row.read_ct),
    enqueued_at: iso(row.enqueued_at),
    vt: iso(row.vt),
    message: row.message ?? null,
    headers: row.headers ?? null,
    ...(row.archived_at != null ? { archived_at: iso(row.archived_at) } : {}),
  };
}

export class QueueService extends BaseContext {
  async status(): Promise<QueueStatus> {
    const [row] = await this.di.prisma.$queryRawUnsafe<Row[]>(`
      SELECT
        EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgmq') AS available,
        (SELECT extversion FROM pg_extension WHERE extname = 'pgmq') AS version,
        EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgmq_public') AS exposed,
        EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_partman') AS partitioned_available
    `);
    return {
      available: Boolean(row.available),
      installed: row.version != null,
      version: row.version == null ? null : String(row.version),
      exposed: Boolean(row.exposed),
      partitionedAvailable: Boolean(row.partitioned_available),
    };
  }

  async list(): Promise<QueueStatus & { queues: QueueInfo[] }> {
    const status = await this.status();
    if (!status.installed) return { ...status, queues: [] };
    const rows = await this.di.prisma.$queryRawUnsafe<Row[]>(`
      SELECT q.queue_name AS name, q.is_partitioned, q.is_unlogged, q.created_at,
             m.queue_length, m.queue_visible_length, m.newest_msg_age_sec, m.oldest_msg_age_sec,
             m.total_messages, c.relrowsecurity AS rls_enabled
        FROM pgmq.list_queues() q
        LEFT JOIN pgmq.metrics_all() m ON m.queue_name = q.queue_name
        LEFT JOIN pg_class c ON c.oid = to_regclass(format('pgmq.%I', 'q_' || q.queue_name))
       ORDER BY q.queue_name
    `);
    return { ...status, queues: rows.map(toQueue) };
  }

  async enable(): Promise<void> {
    const status = await this.status();
    if (!status.available) {
      throw new HttpException(
        'pgmq is not available in this database image. Rebuild the Postgres image from deploy/postgres.Dockerfile ' +
          '(it builds pgmq) and recreate the database container.',
        400,
      );
    }
    await execDdl(this.di.prisma, 'CREATE EXTENSION IF NOT EXISTS pgmq');
  }

  async setExposed(enabled: boolean): Promise<void> {
    await this.requireInstalled();
    await this.inTransaction(exposeStatements(enabled));
  }

  async create(input: { name: string; type: QueueType; rls: boolean }): Promise<QueueInfo> {
    const name = assertQueueName(input.name);
    const status = await this.requireInstalled();
    if (input.type === 'partitioned' && !status.partitionedAvailable) {
      throw new HttpException(
        'Partitioned queues need the pg_partman extension, which this database image does not include. ' +
          'Create a basic or unlogged queue instead.',
        400,
      );
    }
    if (await this.exists(name)) throw new HttpException(`Queue "${name}" already exists`, 409);

    const create = {
      basic: 'SELECT pgmq.create($1)',
      unlogged: 'SELECT pgmq.create_unlogged($1)',
      partitioned: 'SELECT pgmq.create_partitioned($1)',
    }[input.type];

    await this.di.prisma.$transaction(async tx => {
      await this.run(tx, create, name);
      if (input.rls) {
        await this.run(tx, `ALTER TABLE ${queueTable(name)} ENABLE ROW LEVEL SECURITY`);
        await this.run(tx, `ALTER TABLE ${archiveTable(name)} ENABLE ROW LEVEL SECURITY`);
      }
      // A queue made after the schema was exposed still has to be reachable by
      // service_role, whose blanket grant only covered the tables that existed.
      if (status.exposed) {
        await this.run(tx, `GRANT ALL ON ${queueTable(name)}, ${archiveTable(name)} TO service_role`);
      }
    });
    return this.get(name);
  }

  async get(name: string): Promise<QueueInfo> {
    const queue = (await this.list()).queues.find(q => q.name === name);
    if (!queue) throw new HttpException(`Queue "${name}" not found`, 404);
    return queue;
  }

  async drop(name: string): Promise<void> {
    await this.requireQueue(name);
    await this.run(this.di.prisma, 'SELECT pgmq.drop_queue($1)', name);
  }

  async purge(name: string): Promise<number> {
    await this.requireQueue(name);
    const [row] = await this.di.prisma.$queryRawUnsafe<Row[]>('SELECT pgmq.purge_queue($1) AS purged', name);
    return num(row?.purged);
  }

  /**
   * Browse without consuming. `read` would bump each message's read count and
   * hide it for the visibility timeout, which is not what looking at a queue
   * should do, so this selects from the table instead.
   */
  async messages(
    name: string,
    options: { archived?: boolean; limit?: number; offset?: number } = {},
  ): Promise<{ messages: QueueMessage[]; total: number }> {
    await this.requireQueue(name);
    const table = options.archived ? archiveTable(name) : queueTable(name);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const [rows, [count]] = await Promise.all([
      this.di.prisma.$queryRawUnsafe<Row[]>(
        `SELECT * FROM ${table} ORDER BY msg_id DESC LIMIT $1 OFFSET $2`,
        limit,
        offset,
      ),
      this.di.prisma.$queryRawUnsafe<Row[]>(`SELECT count(*)::float8 AS total FROM ${table}`),
    ]);
    return { messages: rows.map(toMessage), total: num(count?.total) };
  }

  async send(name: string, message: unknown, delaySec = 0): Promise<number[]> {
    await this.requireQueue(name);
    const rows = await this.query(
      'SELECT pgmq.send($1, $2::jsonb, $3::integer) AS msg_id',
      name,
      JSON.stringify(message ?? null),
      delaySec,
    );
    return rows.map(row => num(row.msg_id));
  }

  /** A real `pgmq.read`: the messages become invisible for `vt` seconds and their read count goes up. */
  async read(name: string, vt: number, qty: number): Promise<QueueMessage[]> {
    await this.requireQueue(name);
    const rows = await this.query('SELECT * FROM pgmq.read($1, $2::integer, $3::integer)', name, vt, qty);
    return rows.map(toMessage);
  }

  async archive(name: string, msgId: number): Promise<void> {
    await this.requireQueue(name);
    const [row] = await this.query('SELECT pgmq.archive($1, $2::bigint) AS ok', name, msgId);
    if (!row?.ok) throw new HttpException(`Message ${msgId} not found in "${name}"`, 404);
  }

  async deleteMessage(name: string, msgId: number): Promise<void> {
    await this.requireQueue(name);
    const [row] = await this.query('SELECT pgmq.delete($1, $2::bigint) AS ok', name, msgId);
    if (!row?.ok) throw new HttpException(`Message ${msgId} not found in "${name}"`, 404);
  }

  async permissions(name: string): Promise<QueuePermissions> {
    const queue = await this.requireQueue(name);
    const table = `pgmq.q_${name}`;
    const roles = {} as Record<QueueRole, QueuePrivileges>;
    for (const role of QUEUE_ROLES) {
      const [row] = await this.di.prisma.$queryRawUnsafe<Row[]>(
        `SELECT has_table_privilege($1, $2, 'SELECT') AS select,
                has_table_privilege($1, $2, 'INSERT') AS insert,
                has_table_privilege($1, $2, 'UPDATE') AS update,
                has_table_privilege($1, $2, 'DELETE') AS delete`,
        role,
        table,
      );
      roles[role] = {
        select: Boolean(row.select),
        insert: Boolean(row.insert),
        update: Boolean(row.update),
        delete: Boolean(row.delete),
      };
    }
    return { rlsEnabled: queue.rlsEnabled, roles };
  }

  async setPermissions(
    name: string,
    patch: { rlsEnabled?: boolean; roles?: Partial<Record<QueueRole, QueuePrivileges>> },
  ): Promise<QueuePermissions> {
    await this.requireQueue(name);
    const statements: string[] = [];
    if (patch.rlsEnabled !== undefined) {
      const verb = patch.rlsEnabled ? 'ENABLE' : 'DISABLE';
      statements.push(
        `ALTER TABLE ${queueTable(name)} ${verb} ROW LEVEL SECURITY`,
        `ALTER TABLE ${archiveTable(name)} ${verb} ROW LEVEL SECURITY`,
      );
    }
    for (const role of QUEUE_ROLES) {
      const wanted = patch.roles?.[role];
      if (wanted) statements.push(...permissionStatements(name, role, wanted));
    }
    await this.inTransaction(statements);
    return this.permissions(name);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async requireInstalled(): Promise<QueueStatus> {
    const status = await this.status();
    if (!status.installed) {
      throw new HttpException('Queues are not enabled for this project. Enable the pgmq extension first.', 400);
    }
    return status;
  }

  private async exists(name: string): Promise<boolean> {
    const rows = await this.di.prisma.$queryRawUnsafe<Row[]>(
      'SELECT 1 FROM pgmq.meta WHERE queue_name = $1',
      name,
    );
    return rows.length > 0;
  }

  private async requireQueue(name: string): Promise<QueueInfo> {
    assertQueueName(name);
    await this.requireInstalled();
    return this.get(name);
  }

  /** Run one pgmq call, turning its errors into a 400 that keeps Postgres's own message. */
  private async query(sql: string, ...params: unknown[]): Promise<Row[]> {
    try {
      return await this.di.prisma.$queryRawUnsafe<Row[]>(sql, ...params);
    } catch (err) {
      throw new HttpException(formatSqlError(err) || 'Queue operation failed', 400);
    }
  }

  private async run(executor: DdlExecutor, sql: string, ...params: unknown[]): Promise<void> {
    try {
      await execDdl(executor, sql, ...params);
    } catch (err) {
      throw new HttpException(formatSqlError(err) || 'Queue operation failed', 400);
    }
  }

  private async inTransaction(statements: string[]): Promise<void> {
    try {
      await this.di.prisma.$transaction(async tx => {
        for (const sql of statements) await this.run(tx, sql);
      });
    } finally {
      // execDdl invalidated at statement time; a rolled-back transaction needs
      // one more so a read in between cannot pin the uncommitted shape.
      invalidateCatalog();
    }
  }
}
