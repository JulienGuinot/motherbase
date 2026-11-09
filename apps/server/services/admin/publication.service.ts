import prisma from '../../lib/prisma';
import { HttpException } from '../../exceptions/http-exception';
import { execDdl, qualified, quoteIdent } from './schema-ddl';
import { explainPgFailure, PUBLISH_ACTIONS, publishOptionSql, type PublishActions } from './database-ddl';

/**
 * The publication Supabase Realtime reads. A project imported from Supabase
 * brings it along; Motherbase Realtime does not read it (see the class note),
 * so it is flagged for the console to explain rather than silently treated as
 * the switch it was on Supabase.
 */
export const SUPABASE_REALTIME_PUBLICATION = 'supabase_realtime';

export interface PublicationTable {
  schema: string;
  table: string;
}

export interface PublicationInfo extends PublishActions {
  name: string;
  owner: string;
  allTables: boolean;
  /** Publish partition changes as their root table. */
  viaRoot: boolean;
  tables: PublicationTable[];
  /** True for `supabase_realtime`, which this platform's Realtime ignores. */
  supabaseRealtime: boolean;
}

export interface PublicationOverview {
  publications: PublicationInfo[];
  /** Publications only stream when this is `logical`. */
  walLevel: string;
}

export interface CreatePublicationInput extends PublishActions {
  name: string;
  /** Publish every table, present and future. Superuser only. */
  allTables?: boolean;
  tables?: PublicationTable[];
}

export interface UpdatePublicationInput extends Partial<PublishActions> {
  addTables?: PublicationTable[];
  dropTables?: PublicationTable[];
}

/**
 * Logical-replication publications (Database > Publications).
 *
 * Motherbase Realtime is not built on these. It captures row changes in the
 * application (REST writes and the admin row editor enqueue into
 * `platform.realtime_outbox`), and which tables broadcast is the Realtime
 * model list (`realtime.models`). So nothing here can break Realtime, and
 * adding a table to a publication does not make it realtime either: that is
 * the misunderstanding worth guarding against, and the console says so.
 * Publications here are for external subscribers: a read replica, Debezium,
 * a warehouse loader.
 */
export class PublicationService {
  constructor(_di: unknown) {}

  async list(): Promise<PublicationOverview> {
    const [rows, tables, [wal]] = await Promise.all([
      prisma.$queryRawUnsafe<Array<{
        pubname: string; owner: string; puballtables: boolean; pubviaroot: boolean;
        pubinsert: boolean; pubupdate: boolean; pubdelete: boolean; pubtruncate: boolean;
      }>>(`
        SELECT p.pubname, pg_get_userbyid(p.pubowner) AS owner, p.puballtables, p.pubviaroot,
               p.pubinsert, p.pubupdate, p.pubdelete, p.pubtruncate
        FROM pg_publication p
        ORDER BY p.pubname
      `),
      prisma.$queryRawUnsafe<Array<{ pubname: string; schemaname: string; tablename: string }>>(`
        SELECT pubname, schemaname, tablename FROM pg_publication_tables ORDER BY schemaname, tablename
      `),
      prisma.$queryRawUnsafe<Array<{ wal_level: string }>>(`SHOW wal_level`),
    ]);

    return {
      walLevel: wal.wal_level,
      publications: rows.map(row => ({
        name: row.pubname,
        owner: row.owner,
        allTables: row.puballtables,
        viaRoot: row.pubviaroot,
        insert: row.pubinsert,
        update: row.pubupdate,
        delete: row.pubdelete,
        truncate: row.pubtruncate,
        tables: tables
          .filter(table => table.pubname === row.pubname)
          .map(table => ({ schema: table.schemaname, table: table.tablename })),
        supabaseRealtime: row.pubname === SUPABASE_REALTIME_PUBLICATION,
      })),
    };
  }

  async create(input: CreatePublicationInput): Promise<void> {
    const target = input.allTables
      ? ' FOR ALL TABLES'
      : input.tables?.length
        ? ` FOR TABLE ${this.tableList(input.tables)}`
        : '';
    await explainPgFailure(() =>
      execDdl(prisma, `CREATE PUBLICATION ${quoteIdent(input.name)}${target} WITH (${publishOptionSql(input)})`),
    );
  }

  /**
   * Flags and table membership in one transaction: toggling a table and
   * changing what is published are separate ALTERs in Postgres, and a
   * subscriber should never observe half of one edit.
   */
  async update(name: string, input: UpdatePublicationInput): Promise<void> {
    const current = (await this.list()).publications.find(publication => publication.name === name);
    if (!current) throw new HttpException(`Publication "${name}" does not exist`, 404);
    if (current.allTables && (input.addTables?.length || input.dropTables?.length)) {
      throw new HttpException(`"${name}" publishes all tables; its table list cannot be edited`, 400);
    }

    const ident = quoteIdent(name);
    const statements: string[] = [];
    if (PUBLISH_ACTIONS.some(action => input[action] !== undefined)) {
      const actions: PublishActions = {
        insert: input.insert ?? current.insert,
        update: input.update ?? current.update,
        delete: input.delete ?? current.delete,
        truncate: input.truncate ?? current.truncate,
      };
      statements.push(`ALTER PUBLICATION ${ident} SET (${publishOptionSql(actions)})`);
    }
    if (input.addTables?.length) statements.push(`ALTER PUBLICATION ${ident} ADD TABLE ${this.tableList(input.addTables)}`);
    if (input.dropTables?.length) statements.push(`ALTER PUBLICATION ${ident} DROP TABLE ${this.tableList(input.dropTables)}`);
    if (!statements.length) return;

    await explainPgFailure(() =>
      prisma.$transaction(async tx => {
        for (const statement of statements) await execDdl(tx, statement);
      }),
    );
  }

  async drop(name: string): Promise<void> {
    await explainPgFailure(() => execDdl(prisma, `DROP PUBLICATION ${quoteIdent(name)}`));
  }

  private tableList(tables: PublicationTable[]): string {
    return tables.map(({ schema, table }) => qualified(table, schema)).join(', ');
  }
}
