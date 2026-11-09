import prisma from '../../lib/prisma';
import { HttpException } from '../../exceptions/http-exception';
import { assertSchema, execDdl, qualified, quoteIdent } from './schema-ddl';
import { explainPgFailure, quoteLiteral } from './database-ddl';

export interface EnumTypeInfo {
  schema: string;
  name: string;
  /** Labels in sort order, which is the order Postgres compares them in. */
  values: string[];
  comment: string | null;
  /** Columns typed with this enum, as `table.column`. */
  usedBy: string[];
}

/** Where a new label goes. Absent appends it, which is what ADD VALUE does by default. */
export interface EnumValuePosition {
  before?: string;
  after?: string;
}

/**
 * Enumerated types (`CREATE TYPE ... AS ENUM`), Supabase's Database >
 * Enumerated Types.
 *
 * Postgres has no way to remove a label from an enum, only to add or rename
 * one: an existing row may hold it. So the write surface is exactly create,
 * add value, rename value and drop, and the UI does not pretend otherwise.
 *
 * Labels are string literals, not identifiers (`'in progress'` is a legal
 * label), so they go through `quoteLiteral`; type names are identifiers and go
 * through `quoteIdent` like every other name here.
 */
export class EnumTypeService {
  constructor(_di: unknown) {}

  async list(schema?: string): Promise<EnumTypeInfo[]> {
    const nsp = assertSchema(schema);
    const rows = await prisma.$queryRawUnsafe<Array<{
      name: string;
      values: string[] | null;
      comment: string | null;
      used_by: string[] | null;
    }>>(`
      SELECT
        t.typname AS name,
        ARRAY(SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) AS values,
        obj_description(t.oid, 'pg_type') AS comment,
        ARRAY(
          SELECT c.relname || '.' || a.attname
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          WHERE a.atttypid = t.oid AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          ORDER BY 1
        ) AS used_by
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typtype = 'e' AND n.nspname = $1
      ORDER BY t.typname
    `, nsp);

    return rows.map(row => ({
      schema: nsp,
      name: row.name,
      values: row.values ?? [],
      comment: row.comment,
      usedBy: row.used_by ?? [],
    }));
  }

  async create(name: string, values: string[], schema?: string): Promise<void> {
    if (new Set(values).size !== values.length) throw new HttpException('Enum values must be unique', 400);
    const labels = values.map(quoteLiteral).join(', ');
    await explainPgFailure(() => execDdl(prisma, `CREATE TYPE ${qualified(name, schema)} AS ENUM (${labels})`));
  }

  /**
   * Runs autocommitted, never inside a transaction: a label added by
   * `ADD VALUE` cannot be used until the transaction that added it commits.
   */
  async addValue(name: string, value: string, position: EnumValuePosition, schema?: string): Promise<void> {
    if (position.before && position.after) throw new HttpException('Give either before or after, not both', 400);
    const anchor = position.before
      ? ` BEFORE ${quoteLiteral(position.before)}`
      : position.after
        ? ` AFTER ${quoteLiteral(position.after)}`
        : '';
    await explainPgFailure(() =>
      execDdl(prisma, `ALTER TYPE ${qualified(name, schema)} ADD VALUE ${quoteLiteral(value)}${anchor}`),
    );
  }

  async renameValue(name: string, from: string, to: string, schema?: string): Promise<void> {
    await explainPgFailure(() =>
      execDdl(prisma, `ALTER TYPE ${qualified(name, schema)} RENAME VALUE ${quoteLiteral(from)} TO ${quoteLiteral(to)}`),
    );
  }

  async rename(name: string, to: string, schema?: string): Promise<void> {
    await explainPgFailure(() => execDdl(prisma, `ALTER TYPE ${qualified(name, schema)} RENAME TO ${quoteIdent(to)}`));
  }

  /**
   * No CASCADE: dropping an enum a column still uses would drop the column
   * with it. Postgres refuses, and the refusal names the column.
   */
  async drop(name: string, schema?: string): Promise<void> {
    await explainPgFailure(() => execDdl(prisma, `DROP TYPE ${qualified(name, schema)}`));
  }
}
