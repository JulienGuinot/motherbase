import { HttpException } from '../../exceptions/http-exception';
import { invalidateCatalog } from '../rest-api/catalog';
import { IDENTIFIER_RE, quoteIdentStrict } from '../../lib/sql-identifier';
// `.` admits a schema-qualified type such as an enum declared outside public.
const COLUMN_TYPE_RE = /^[A-Za-z0-9_ ()[\],.]+$/;
const ON_DELETE_ACTIONS = new Set(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION']);

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
}

interface ColumnForeignKey {
  /** Referenced table name (same schema as the column's table). */
  table: string;
  /** Referenced column name. */
  column: string;
  /** Referential action on delete of the parent row. */
  onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
}

export interface ColumnDef {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  isPrimaryKey?: boolean;
  /** Add a UNIQUE constraint on the column. */
  unique?: boolean;
  /** Raw CHECK expression, e.g. `age >= 0` (admin-authored SQL, like `default`). */
  check?: string | null;
  /** Postgres column comment (stored via COMMENT ON COLUMN). */
  comment?: string | null;
  /** Foreign-key relation to another table in the same schema. */
  references?: ColumnForeignKey | null;
}

/** Anything that can run a raw statement: the Prisma client or a transaction client. */
export interface DdlExecutor {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

/**
 * The single choke point for schema-changing statements.
 *
 * Every DDL path (SchemaService, SqlService write statements, SchemaMigration
 * apply/rollback) runs through here so the catalog cache is invalidated in ONE
 * place. The alternative, an `invalidateCatalog()` call next to each of the
 * fifteen `$executeRawUnsafe` sites, rots the moment someone adds a sixteenth:
 * the failure mode is silent (a stale REST schema), not a red test. Routing the
 * execution itself through this function makes "ran DDL" and "invalidated"
 * impossible to separate.
 *
 * Invalidation is in `finally` because a statement that errors part-way (a
 * multi-statement batch, or a DDL that fails after acquiring its lock) can still
 * have changed the schema. Dropping the cache on failure costs one reload;
 * keeping a stale cache costs correctness.
 *
 * Note for transactional callers: this fires at statement time, not commit time.
 * A rolled-back transaction therefore needs a second invalidation once the
 * transaction settles, because a concurrent read could have repopulated the
 * cache from uncommitted-to-us state. `SchemaMigrationService` does exactly that.
 *
 * The one path that cannot use this hook is `ImportService`, which applies DDL
 * out of process through `psql`; it invalidates explicitly and says so.
 */
export async function execDdl<T = unknown>(
  executor: DdlExecutor,
  sql: string,
  ...params: unknown[]
): Promise<T> {
  try {
    return (await executor.$executeRawUnsafe(sql, ...params)) as T;
  } finally {
    invalidateCatalog();
  }
}

/** Validate and double-quote a SQL identifier; reject anything unexpected. */
export const quoteIdent = quoteIdentStrict;

/** Validate a schema name, defaulting to `public`. */
export function assertSchema(name?: string | null): string {
  if (name == null || name === '') return 'public';
  if (typeof name !== 'string' || !IDENTIFIER_RE.test(name)) {
    throw new HttpException(`Invalid schema name: ${String(name)}`, 400);
  }
  return name;
}

/** Quote a schema-qualified table reference: "schema"."table". */
export function qualified(table: string, schema?: string | null): string {
  return `${quoteIdent(assertSchema(schema))}.${quoteIdent(table)}`;
}

/** Restrict column types to a safe charset (e.g. varchar(255), numeric(10,2), text[], reporting.mood). */
export function assertSafeColumnType(type: string): string {
  if (typeof type !== 'string' || !COLUMN_TYPE_RE.test(type.trim())) {
    throw new HttpException(`Invalid column type: ${String(type)}`, 400);
  }
  return type.trim();
}

/** Reject raw SQL fragments that try to append extra statements. */
function assertSafeExpression(expression: string, label: string): string {
  if (expression.includes(';')) {
    throw new HttpException(`Invalid ${label} expression: statements are not allowed`, 400);
  }
  return expression.trim();
}

/**
 * Build a safe ALTER TABLE … ADD COLUMN statement and optional parameterized
 * comment statement. The default/check fragments retain the admin raw-SQL
 * trust model while rejecting statement separators.
 */
export function buildAddColumnSql(
  table: string,
  column: ColumnDef,
  schema?: string,
): { sql: string; comment?: { sql: string; param: string } } {
  const type = assertSafeColumnType(column.type);
  const primaryKey = column.isPrimaryKey ? ' PRIMARY KEY' : '';
  const unique = column.unique ? ' UNIQUE' : '';
  const notNull = column.nullable ? '' : ' NOT NULL';
  const defaultClause = column.default
    ? ` DEFAULT ${assertSafeExpression(column.default, 'default')}`
    : '';

  let references = '';
  if (column.references) {
    let onDelete = '';
    if (column.references.onDelete) {
      if (!ON_DELETE_ACTIONS.has(column.references.onDelete)) {
        throw new HttpException(`Invalid ON DELETE action: ${column.references.onDelete}`, 400);
      }
      onDelete = ` ON DELETE ${column.references.onDelete}`;
    }
    references = ` REFERENCES ${qualified(column.references.table, schema)} (${quoteIdent(column.references.column)})${onDelete}`;
  }

  const check = column.check ? ` CHECK (${assertSafeExpression(column.check, 'check')})` : '';
  const sql = `ALTER TABLE ${qualified(table, schema)} ADD COLUMN ${quoteIdent(column.name)} ${type}${primaryKey}${unique}${notNull}${defaultClause}${references}${check}`;

  if (column.comment != null && column.comment !== '') {
    return {
      sql,
      comment: {
        sql: `COMMENT ON COLUMN ${qualified(table, schema)}.${quoteIdent(column.name)} IS $1`,
        param: column.comment,
      },
    };
  }
  return { sql };
}
