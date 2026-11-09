import { createHash } from 'crypto';
import { formatSqlError } from '../../lib/pg-error';
import { INTERNAL_TABLE_RE } from '../../constants/regex.constants';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { HttpException } from '../../exceptions/http-exception';
import { execDdl, quoteIdent } from './schema-ddl';
import { invalidateCatalog } from '../rest-api/catalog';
import { splitStatements } from './sql.service';
import { versionAt } from './git/migration-files';
import { prepareScript } from './sql-script';
import type { SchemaService } from './schema.service';

// Tables we never snapshot/diff: everything INTERNAL_TABLE_RE covers, plus the
// Motherbase-managed application tables (owned by prisma migrate, not by the
// Studio schema-migration workflow) listed by `systemTableNames()`.
const SCHEMA_MIGRATION_LOCK = 'motherbase:schema-migrations';

// Prisma's interactive transactions time out after 5s by default, which a real
// migration (an index build, a backfill) outlives.
export const LONG_TRANSACTION = { maxWait: 10_000, timeout: 10 * 60_000 };

/** The set of table (db) names owned by the app's Prisma schema. Excluded from snapshots. */
function systemTableNames(): Set<string> {
  return new Set(
    Prisma.dmmf.datamodel.models.map(m => (m.dbName ?? m.name).toLowerCase())
  );
}

// ── Snapshot / diff shapes ────────────────────────────────────────────────────

export interface SnapshotColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
}

export interface SnapshotIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

interface SnapshotTable {
  name: string;
  columns: SnapshotColumn[];
  indexes: SnapshotIndex[];
}

export interface Snapshot {
  tables: SnapshotTable[];
}

export interface ColumnChange {
  name: string;
  from: SnapshotColumn;
  to: SnapshotColumn;
}

interface TableDiff {
  table: string;
  addedColumns: SnapshotColumn[];
  droppedColumns: SnapshotColumn[];
  changedColumns: ColumnChange[];
  addedIndexes: SnapshotIndex[];
  droppedIndexes: SnapshotIndex[];
}

export interface SchemaDiff {
  addedTables: SnapshotTable[];
  droppedTables: SnapshotTable[];
  changedTables: TableDiff[];
}

/** Where a migration was authored. */
export type MigrationOrigin = 'studio' | 'cli' | 'git';

export interface SchemaMigrationRow {
  id: string;
  version: string;
  name: string;
  origin: string;
  upSql: string;
  downSql: string | null;
  checksum: string;
  snapshot: Prisma.JsonValue | null;
  snapshotChecksum: string | null;
  status: string;
  appliedAt: Date | null;
  createdAt: Date;
}

/**
 * One row of the migration history, in the shape of Supabase's
 * `supabase_migrations.schema_migrations` (version, name, statements) plus what
 * Motherbase tracks on top: where it came from and whether it is applied.
 */
export interface MigrationHistoryEntry {
  id: string;
  version: string;
  name: string;
  statements: string[];
  /** The migration file's up SQL, verbatim (comments included). */
  sql: string;
  downSql: string | null;
  origin: string;
  status: string;
  appliedAt: Date | null;
}

/** A migration as a local `<version>_<name>.sql` file describes it. */
export interface MigrationFileInput {
  version: string;
  name: string;
  sql: string;
  downSql?: string | null;
}

const VERSION_RE = /^\d{1,32}$/;

/** Validate a history version: digits only, the file-name prefix. */
export function assertVersion(version: unknown): string {
  const value = typeof version === 'string' ? version.trim() : '';
  if (!VERSION_RE.test(value)) {
    throw new HttpException(`Invalid migration version "${String(version)}": expected the digits of a <version>_<name>.sql prefix`, 400);
  }
  return value;
}

/**
 * Down SQL, or null when there is none to run. A `-- @down` section holding
 * only comments (what `migration new` scaffolds) is no down at all: storing it
 * would make rollback "succeed" while undoing nothing.
 */
export function downSqlOf(sql: string | null | undefined): string | null {
  return sql && splitStatements(sql).length ? sql.trim() : null;
}

export function toHistoryEntry(row: SchemaMigrationRow): MigrationHistoryEntry {
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    statements: splitStatements(row.upSql),
    sql: row.upSql,
    downSql: row.downSql,
    origin: row.origin,
    status: row.status,
    appliedAt: row.appliedAt,
  };
}

/**
 * Run a migration's SQL one statement at a time. Prisma sends raw SQL as a
 * prepared statement, and Postgres refuses more than one command in one of
 * those ("cannot insert multiple commands into a prepared statement"), so
 * handing it a whole migration file failed on any file with two statements.
 */
export async function runStatements(tx: Prisma.TransactionClient, sql: string): Promise<void> {
  for (const statement of splitStatements(prepareScript(sql))) await execDdl(tx, statement);
}

const sortByName = <T extends { name: string }>(items: T[]): T[] =>
  [...items].sort((a, b) => a.name.localeCompare(b.name));

/** Parse the column list out of a `CREATE [UNIQUE] INDEX ... ON t USING m (a, b)` definition. */
function indexColumns(definition: string): string[] {
  const open = definition.lastIndexOf('(');
  const close = definition.lastIndexOf(')');
  if (open === -1 || close === -1 || close <= open) return [];
  return definition
    .slice(open + 1, close)
    .split(',')
    .map(part => part.trim().replace(/^"(.*)"$/, '$1').split(/\s+/)[0])
    .filter(Boolean);
}

export class SchemaMigrationService {
  private schema: SchemaService;

  constructor(di: { SchemaService: SchemaService }) {
    this.schema = di.SchemaService;
  }

  // ── Snapshot ────────────────────────────────────────────────────────────────

  /**
   * A normalized, deterministically-ordered snapshot of the current user schema.
   * Internal/system tables are excluded; tables, columns and indexes are sorted by
   * name so checksums and diffs are stable across runs.
   */
  async snapshot(client?: Pick<Prisma.TransactionClient, '$queryRawUnsafe'>): Promise<Snapshot> {
    const system = systemTableNames();
    const tables = await this.schema.listTables(undefined, client);
    const userTables = tables.filter(
      t => !INTERNAL_TABLE_RE.test(t.name) && !system.has(t.name.toLowerCase())
    );

    const result: SnapshotTable[] = [];
    for (const table of userTables) {
      const indexes = await this.schema.listIndexes(table.name, undefined, client);
      result.push({
        name: table.name,
        columns: sortByName(
          table.columns.map(c => ({
            name: c.name,
            type: c.type,
            nullable: c.nullable,
            default: c.default ?? null,
          }))
        ),
        indexes: sortByName(
          indexes.map(i => ({
            name: i.name,
            columns: indexColumns(i.definition),
            unique: i.unique,
          }))
        ),
      });
    }

    return { tables: sortByName(result) };
  }

  // ── Diff ──────────────────────────────────────────────────────────────────────

  diff(from: Snapshot, to: Snapshot): SchemaDiff {
    const fromTables = new Map(from.tables.map(t => [t.name, t]));
    const toTables = new Map(to.tables.map(t => [t.name, t]));

    const addedTables = sortByName(to.tables.filter(t => !fromTables.has(t.name)));
    const droppedTables = sortByName(from.tables.filter(t => !toTables.has(t.name)));

    const changedTables: TableDiff[] = [];
    for (const toTable of to.tables) {
      const fromTable = fromTables.get(toTable.name);
      if (!fromTable) continue; // added table, handled above

      const fromCols = new Map(fromTable.columns.map(c => [c.name, c]));
      const toCols = new Map(toTable.columns.map(c => [c.name, c]));

      const addedColumns = sortByName(toTable.columns.filter(c => !fromCols.has(c.name)));
      const droppedColumns = sortByName(fromTable.columns.filter(c => !toCols.has(c.name)));
      const changedColumns: ColumnChange[] = [];
      for (const toCol of toTable.columns) {
        const fromCol = fromCols.get(toCol.name);
        if (!fromCol) continue;
        if (
          fromCol.type !== toCol.type ||
          fromCol.nullable !== toCol.nullable ||
          fromCol.default !== toCol.default
        ) {
          changedColumns.push({ name: toCol.name, from: fromCol, to: toCol });
        }
      }
      changedColumns.sort((a, b) => a.name.localeCompare(b.name));

      const fromIdx = new Map(fromTable.indexes.map(i => [i.name, i]));
      const toIdx = new Map(toTable.indexes.map(i => [i.name, i]));
      const addedIndexes = sortByName(toTable.indexes.filter(i => !fromIdx.has(i.name)));
      const droppedIndexes = sortByName(fromTable.indexes.filter(i => !toIdx.has(i.name)));

      if (
        addedColumns.length ||
        droppedColumns.length ||
        changedColumns.length ||
        addedIndexes.length ||
        droppedIndexes.length
      ) {
        changedTables.push({
          table: toTable.name,
          addedColumns,
          droppedColumns,
          changedColumns,
          addedIndexes,
          droppedIndexes,
        });
      }
    }
    changedTables.sort((a, b) => a.table.localeCompare(b.table));

    return { addedTables, droppedTables, changedTables };
  }

  // ── Diff → suggested DDL ───────────────────────────────────────────────────────

  private columnClause(col: SnapshotColumn): string {
    const notNull = col.nullable ? '' : ' NOT NULL';
    const def = col.default != null ? ` DEFAULT ${col.default}` : '';
    // `col.type` comes from introspection (udt_name), not user input; quote the
    // name/table but leave the type as-is (validated set of catalog types).
    return `${quoteIdent(col.name)} ${col.type}${notNull}${def}`;
  }

  /**
   * Best-effort DDL suggestion for a diff. This is a starting point the operator
   * MUST review before applying: complex constraint/FK/type changes may need
   * manual edits. Ordering: drop dependents (indexes, columns, tables) before
   * creating new parents, then add tables → columns → indexes.
   */
  diffToDdl(diff: SchemaDiff): string {
    const header = [
      '-- ⚠ AUTO-GENERATED best-effort migration suggestion, REVIEW BEFORE APPLYING.',
      '-- Foreign keys, check constraints, complex type casts and data backfills are',
      '-- NOT handled here and may require manual edits. Verify against your data.',
      '',
    ];
    const drops: string[] = [];
    const creates: string[] = [];

    // 1) Drops first (indexes → columns → tables), so dependents go before parents.
    for (const table of diff.changedTables) {
      for (const idx of table.droppedIndexes) {
        drops.push(`DROP INDEX IF EXISTS ${quoteIdent(idx.name)};`);
      }
    }
    for (const table of diff.changedTables) {
      for (const col of table.droppedColumns) {
        drops.push(`ALTER TABLE ${quoteIdent(table.table)} DROP COLUMN ${quoteIdent(col.name)};`);
      }
    }
    for (const table of diff.droppedTables) {
      drops.push(`DROP TABLE IF EXISTS ${quoteIdent(table.name)} CASCADE;`);
    }

    // 2) Create new tables (parents) before altering/adding to existing ones.
    for (const table of diff.addedTables) {
      const cols = table.columns.map(c => `  ${this.columnClause(c)}`).join(',\n');
      creates.push(`CREATE TABLE ${quoteIdent(table.name)} (\n${cols}\n);`);
      for (const idx of table.indexes) {
        creates.push(this.createIndexSql(table.name, idx));
      }
    }

    // 3) Column additions and alterations on existing tables.
    for (const table of diff.changedTables) {
      for (const col of table.addedColumns) {
        creates.push(`ALTER TABLE ${quoteIdent(table.table)} ADD COLUMN ${this.columnClause(col)};`);
      }
      for (const change of table.changedColumns) {
        creates.push(...this.columnChangeSql(table.table, change));
      }
      for (const idx of table.addedIndexes) {
        creates.push(this.createIndexSql(table.table, idx));
      }
    }

    const body = [...drops, ...creates];
    if (!body.length) return `${header.join('\n')}-- No changes detected.\n`;
    return `${header.join('\n')}${body.join('\n')}\n`;
  }

  private createIndexSql(table: string, idx: SnapshotIndex): string {
    const cols = idx.columns.map(quoteIdent).join(', ');
    const uniq = idx.unique ? 'UNIQUE ' : '';
    return `CREATE ${uniq}INDEX IF NOT EXISTS ${quoteIdent(idx.name)} ON ${quoteIdent(table)} (${cols});`;
  }

  private columnChangeSql(table: string, change: ColumnChange): string[] {
    const out: string[] = [];
    const col = quoteIdent(change.name);
    const t = quoteIdent(table);
    if (change.from.type !== change.to.type) {
      out.push(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${change.to.type} USING ${col}::${change.to.type};`);
    }
    if (change.from.nullable !== change.to.nullable) {
      out.push(
        `ALTER TABLE ${t} ALTER COLUMN ${col} ${change.to.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'};`
      );
    }
    if (change.from.default !== change.to.default) {
      out.push(
        change.to.default == null
          ? `ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT;`
          : `ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${change.to.default};`
      );
    }
    return out;
  }

  /** Diff the latest applied snapshot (or empty on a fresh install) against live. */
  async liveDiff(): Promise<{ diff: SchemaDiff; suggestedSql: string }> {
    const latest = await prisma.schemaMigration.findFirst({
      where: { status: 'applied' },
      orderBy: [{ appliedAt: 'desc' }, { createdAt: 'desc' }],
    });
    const to = await this.snapshot();
    let from: Snapshot = { tables: [] };

    if (latest) {
      if (!latest.snapshot || !latest.snapshotChecksum) {
        throw new HttpException(
          'The latest applied migration has no schema snapshot; apply a new migration to establish a baseline.',
          409,
        );
      }
      from = latest.snapshot as unknown as Snapshot;
      if (this.checksumOfSnapshot(from) !== latest.snapshotChecksum) {
        throw new HttpException('The latest schema snapshot checksum is invalid.', 409);
      }
    }

    const diff = this.diff(from, to);
    return { diff, suggestedSql: this.diffToDdl(diff) };
  }

  // ── Migration lifecycle ─────────────────────────────────────────────────────

  private checksumOf(upSql: string): string {
    return createHash('sha256').update(upSql, 'utf8').digest('hex');
  }

  private checksumOfSnapshot(snapshot: Snapshot): string {
    return createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex');
  }

  /** Serialize every history writer: apply, rollback, push, repair, reset. */
  async lock(tx: Prisma.TransactionClient): Promise<void> {
    // Selected FROM the function: Prisma cannot deserialize the `void` it returns,
    // so `SELECT pg_advisory_xact_lock(...)` threw on every apply and rollback.
    await tx.$queryRawUnsafe(
      'SELECT 1 FROM pg_advisory_xact_lock(hashtext($1))',
      SCHEMA_MIGRATION_LOCK,
    );
  }

  /**
   * Newest version first, so a file pushed from the CLI sorts where its name
   * says. Without the schema snapshot each applied row carries: it is the diff
   * baseline, read by `liveDiff` alone, and a whole schema per row made this
   * listing (and the MCP `list_migrations` built on it) grow with every migration.
   */
  async list(): Promise<Array<Omit<SchemaMigrationRow, 'snapshot'>>> {
    const rows = await prisma.schemaMigration.findMany({ orderBy: { version: 'desc' } });
    return rows.map(({ snapshot: _snapshot, ...row }) => row);
  }

  /** Every migration, oldest version first: the order they apply in. */
  async history(): Promise<MigrationHistoryEntry[]> {
    const rows = await prisma.schemaMigration.findMany({ orderBy: { version: 'asc' } });
    return rows.map(toHistoryEntry);
  }

  /**
   * A version for a migration that has no file name to take one from. Its
   * creation second, like `migration new` stamps, moved forward past any
   * version already taken so two migrations created in the same second both fit.
   */
  private async nextVersion(client: Prisma.TransactionClient = prisma): Promise<string> {
    let at = Date.now();
    for (;;) {
      const version = versionAt(new Date(at));
      if (!(await client.schemaMigration.findUnique({ where: { version } }))) return version;
      at += 1000;
    }
  }

  async get(id: string): Promise<SchemaMigrationRow> {
    const row = await prisma.schemaMigration.findUnique({ where: { id } });
    if (!row) throw new HttpException(`Migration not found: ${id}`, 404);
    return row;
  }

  async create(input: {
    name?: string;
    upSql?: string;
    downSql?: string | null;
    version?: string | null;
    origin?: MigrationOrigin;
  }): Promise<SchemaMigrationRow> {
    const name = input?.name?.trim();
    const upSql = input?.upSql?.trim();
    if (!name) throw new HttpException('name is required', 400);
    if (!upSql) throw new HttpException('upSql is required', 400);
    const downSql = downSqlOf(input?.downSql);
    const version = input.version ? assertVersion(input.version) : await this.nextVersion();
    if (await prisma.schemaMigration.findUnique({ where: { version } })) {
      throw new HttpException(`A migration with version ${version} already exists`, 409);
    }
    return prisma.schemaMigration.create({
      data: {
        version,
        name,
        origin: input.origin ?? 'studio',
        upSql,
        downSql,
        checksum: this.checksumOf(upSql),
        status: 'pending',
      },
    });
  }

  /**
   * Apply one local migration file, the unit `db push` works in.
   *
   * Recording and running happen in ONE transaction: a statement that fails
   * leaves neither a half-applied schema nor a history row claiming it ran,
   * so the next push retries the same file. A pending row with the same
   * version (created in Studio, or by an earlier failed push through the old
   * create-then-apply path) is taken over: the file is the source of truth.
   */
  async push(input: MigrationFileInput): Promise<SchemaMigrationRow> {
    const version = assertVersion(input.version);
    try {
      await prisma.$transaction(async tx => {
        await this.lock(tx);
        await this.applyFile(tx, input);
      }, LONG_TRANSACTION);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(formatSqlError(err) || 'Failed to push migration', 400);
    } finally {
      invalidateCatalog();
    }

    return this.getByVersion(version);
  }

  /**
   * The body of `push`, for a caller that already holds the migration lock in
   * `tx` and owns the transaction (`db reset` replays a whole directory in one).
   */
  async applyFile(tx: Prisma.TransactionClient, input: MigrationFileInput): Promise<void> {
    const version = assertVersion(input.version);
    const name = input.name?.trim();
    const upSql = input.sql?.trim();
    if (!name) throw new HttpException('name is required', 400);
    if (!upSql) throw new HttpException(`Migration ${version} is empty`, 400);
    const downSql = downSqlOf(input.downSql);

    const existing = await tx.schemaMigration.findUnique({ where: { version } });
    if (existing?.status === 'applied') {
      throw new HttpException(`Migration ${version} is already applied`, 409);
    }

    try {
      await runStatements(tx, upSql);
    } catch (err) {
      throw new HttpException(`Migration ${version}_${name} failed: ${formatSqlError(err) || 'unknown error'}`, 400);
    }
    const snapshot = await this.snapshot(tx);
    const applied = {
      name,
      upSql,
      downSql,
      checksum: this.checksumOf(upSql),
      status: 'applied',
      appliedAt: new Date(),
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      snapshotChecksum: this.checksumOfSnapshot(snapshot),
    };
    if (existing) await tx.schemaMigration.update({ where: { id: existing.id }, data: applied });
    else await tx.schemaMigration.create({ data: { version, origin: 'cli', ...applied } });
  }

  /**
   * Rewrite the history without running any SQL, Supabase's `migration repair`.
   *
   * `applied` records that the database already has this migration (it was
   * run by hand, or restored from a dump), and snapshots the live schema as
   * the new diff baseline. `reverted` marks it rolled back so the next push
   * applies it again. The row is kept rather than deleted, unlike Supabase,
   * so Studio still shows what was authored.
   */
  async repair(
    versionInput: string,
    input: { status: 'applied' | 'reverted'; name?: string; sql?: string; downSql?: string | null },
  ): Promise<SchemaMigrationRow> {
    const version = assertVersion(versionInput);
    await prisma.$transaction(async tx => {
      await this.lock(tx);
      const existing = await tx.schemaMigration.findUnique({ where: { version } });

      if (input.status === 'reverted') {
        if (!existing) throw new HttpException(`No migration with version ${version} in the history`, 404);
        await tx.schemaMigration.update({ where: { id: existing.id }, data: { status: 'rolledback', appliedAt: null } });
        return;
      }

      const upSql = input.sql?.trim() || existing?.upSql || '';
      const snapshot = await this.snapshot(tx);
      const applied = {
        upSql,
        checksum: this.checksumOf(upSql),
        status: 'applied',
        appliedAt: new Date(),
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        snapshotChecksum: this.checksumOfSnapshot(snapshot),
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        ...(input.downSql !== undefined ? { downSql: downSqlOf(input.downSql) } : {}),
      };
      if (existing) {
        await tx.schemaMigration.update({ where: { id: existing.id }, data: applied });
      } else {
        await tx.schemaMigration.create({
          data: { version, name: input.name?.trim() || version, origin: 'cli', downSql: null, ...applied },
        });
      }
    }, LONG_TRANSACTION);
    return this.getByVersion(version);
  }

  async getByVersion(version: string): Promise<SchemaMigrationRow> {
    const row = await prisma.schemaMigration.findUnique({ where: { version } });
    if (!row) throw new HttpException(`Migration not found: ${version}`, 404);
    return row;
  }

  /**
   * Apply a migration's upSql inside a single transaction so a failed statement
   * leaves nothing half-applied. Drift handling: if the stored checksum no longer
   * matches upSql (i.e. the SQL was edited after creation), we RE-SYNC the checksum
   * to the SQL that was actually applied: the applied row always reflects what ran.
   */
  async apply(id: string): Promise<SchemaMigrationRow> {
    try {
      // execDdl invalidates at statement time, inside the transaction. If this
      // transaction rolls back, a concurrent reader may have repopulated the
      // cache from a schema state that never committed, so invalidate again once
      // the transaction has settled either way (see the finally below).
      await prisma.$transaction(async tx => {
        await this.lock(tx);
        const migration = await tx.schemaMigration.findUnique({ where: { id } });
        if (!migration) throw new HttpException(`Migration not found: ${id}`, 404);
        if (migration.status === 'applied') {
          throw new HttpException(`Migration ${id} is already applied`, 409);
        }
        if (!['pending', 'rolledback'].includes(migration.status)) {
          throw new HttpException(`Migration ${id} cannot be applied from status ${migration.status}`, 409);
        }

        await runStatements(tx, migration.upSql);
        const snapshot = await this.snapshot(tx);
        const updated = await tx.schemaMigration.updateMany({
          where: { id, status: migration.status },
          data: {
            status: 'applied',
            appliedAt: new Date(),
            checksum: this.checksumOf(migration.upSql),
            snapshot: snapshot as unknown as Prisma.InputJsonValue,
            snapshotChecksum: this.checksumOfSnapshot(snapshot),
          },
        });
        if (updated.count !== 1) {
          throw new HttpException(`Migration ${id} changed state while applying`, 409);
        }
      }, LONG_TRANSACTION);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(formatSqlError(err) || 'Failed to apply migration', 400);
    } finally {
      invalidateCatalog();
    }

    return this.get(id);
  }

  /**
   * Roll back an applied migration by running its downSql transactionally.
   * Requires downSql to be present and the migration to be currently applied.
   */
  async rollback(id: string): Promise<SchemaMigrationRow> {
    try {
      await prisma.$transaction(async tx => {
        await this.lock(tx);
        const migration = await tx.schemaMigration.findUnique({ where: { id } });
        if (!migration) throw new HttpException(`Migration not found: ${id}`, 404);
        if (migration.status !== 'applied') {
          throw new HttpException(`Migration ${id} is not applied (status: ${migration.status})`, 409);
        }
        if (!migration.downSql?.trim()) {
          throw new HttpException(`Migration ${id} has no downSql to roll back`, 400);
        }

        const latest = await tx.schemaMigration.findFirst({
          where: { status: 'applied' },
          orderBy: [{ appliedAt: 'desc' }, { createdAt: 'desc' }],
        });
        if (latest?.id !== id) {
          throw new HttpException('Only the latest applied migration can be rolled back.', 409);
        }

        await runStatements(tx, migration.downSql);
        const updated = await tx.schemaMigration.updateMany({
          where: { id, status: 'applied' },
          data: { status: 'rolledback', appliedAt: null },
        });
        if (updated.count !== 1) {
          throw new HttpException(`Migration ${id} changed state while rolling back`, 409);
        }
      }, LONG_TRANSACTION);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(formatSqlError(err) || 'Failed to roll back migration', 400);
    } finally {
      // Same reasoning as apply(): settle-time invalidation on top of the
      // statement-time one inside execDdl.
      invalidateCatalog();
    }

    return this.get(id);
  }
}
