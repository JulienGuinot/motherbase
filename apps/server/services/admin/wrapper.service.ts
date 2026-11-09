import BaseContext from '../../context/base-context';
import { HttpException } from '../../exceptions/http-exception';
import { formatSqlError } from '../../lib/pg-error';
import { QUIET_TRANSACTION_SQL } from '../../lib/quiet-transaction';
import { invalidateCatalog } from '../rest-api/catalog';
import { assertSafeColumnType, execDdl, quoteIdent, type DdlExecutor } from './schema-ddl';

/**
 * Supabase Wrappers, on the foreign data wrappers Postgres itself ships.
 *
 * Supabase's Wrappers are a Rust extension (Stripe, Firebase, S3, ...) that this
 * image cannot carry. What it can is core Postgres's own: `postgres_fdw` (another
 * Postgres, reached as local tables) and `file_fdw` (a CSV or text file on the
 * database server). The management model is Supabase's: enable a wrapper, create
 * a server with its options and credentials, then bring remote tables in with
 * IMPORT FOREIGN SCHEMA (or, for a file, a foreign table with its columns).
 *
 * Credentials go to the Vault, as Supabase stores wrapper keys: a server's
 * password is the Vault secret `fdw_<server>`. postgres_fdw cannot read a Vault
 * (Supabase's Rust wrappers can, through a secret id option), so the user mapping
 * still carries the password too: Postgres keeps it in pg_user_mapping, readable
 * by superusers only. The Vault copy is the one Studio shows, rotates and deletes
 * with the server; `setCredentials` writes both at once so they cannot diverge.
 *
 * The mapping is for the role this server connects as, and no other. Foreign
 * tables cannot carry row level security, so the REST API never serves them
 * (see isRestExposable), and giving the API roles a mapping would only widen who
 * can reach the remote database through a function.
 */

export const WRAPPERS = ['postgres_fdw', 'file_fdw'] as const;
export type WrapperName = (typeof WRAPPERS)[number];

export interface WrapperInfo {
  name: WrapperName;
  available: boolean;
  installed: boolean;
}

export interface ForeignServerInfo {
  name: string;
  wrapper: string;
  options: Record<string, string>;
  /** A user mapping exists for the role this server connects as. */
  hasUserMapping: boolean;
  /** The mapped remote user, never the password. */
  remoteUser: string | null;
  /** The Vault secret holding the password, when one was stored. */
  vaultSecretId: string | null;
  foreignTables: number;
}

export interface ForeignTableInfo {
  schema: string;
  name: string;
  server: string;
  options: Record<string, string>;
  columns: number;
}

export interface CreateServerInput {
  name: string;
  wrapper: WrapperName;
  options: Record<string, string>;
  user?: string;
  password?: string;
}

export interface ImportSchemaInput {
  remoteSchema: string;
  localSchema: string;
  tables?: string[];
}

export interface CreateForeignTableInput {
  server: string;
  schema: string;
  name: string;
  columns: Array<{ name: string; type: string }>;
  options: Record<string, string>;
}

type Row = Record<string, unknown>;

/** Option names are plain words for both wrappers (host, dbname, filename, header, ...). */
const OPTION_NAME_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * postgres_fdw refuses `user` and `password` as server options (they belong on
 * the user mapping), so they are refused here too, with the reason, instead of
 * surfacing as a Postgres error after the Vault write.
 */
const MAPPING_ONLY_OPTIONS = new Set(['user', 'password']);

/** The Vault name a server's password is stored under. */
export const credentialSecretName = (server: string) => `fdw_${server}`;

/** A SQL string literal. standard_conforming_strings is on, so doubling the quote is the whole escape. */
export const quoteLiteral = (value: string) => `'${String(value).replace(/'/g, "''")}'`;

/** `OPTIONS (key 'value', ...)`, or '' for none. Keys are validated, values quoted. */
export function optionsClause(options: Record<string, string>, verb?: 'ADD' | 'SET'): string {
  const entries = Object.entries(options).filter(([, value]) => value !== undefined && value !== '');
  if (!entries.length) return '';
  for (const [key] of entries) {
    if (!OPTION_NAME_RE.test(key)) throw new HttpException(`Invalid option name: ${key}`, 400);
  }
  const prefix = verb ? `${verb} ` : '';
  return ` OPTIONS (${entries.map(([key, value]) => `${prefix}${key} ${quoteLiteral(value)}`).join(', ')})`;
}

/** `{host=db,port=5432}` from pg_catalog into `{ host: 'db', port: '5432' }`. */
export function parseOptions(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of Array.isArray(raw) ? raw : []) {
    const text = String(entry);
    const at = text.indexOf('=');
    if (at > 0) out[text.slice(0, at)] = text.slice(at + 1);
  }
  return out;
}

export function importSchemaSql(server: string, input: ImportSchemaInput): string {
  const limit = input.tables?.length ? ` LIMIT TO (${input.tables.map(quoteIdent).join(', ')})` : '';
  return (
    `IMPORT FOREIGN SCHEMA ${quoteIdent(input.remoteSchema)}${limit} ` +
    `FROM SERVER ${quoteIdent(server)} INTO ${quoteIdent(input.localSchema)}`
  );
}

export class WrapperService extends BaseContext {
  async list(): Promise<{ wrappers: WrapperInfo[]; servers: ForeignServerInfo[]; tables: ForeignTableInfo[] }> {
    const prisma = this.di.prisma;
    const [available, servers, tables] = await Promise.all([
      prisma.$queryRawUnsafe<Row[]>(
        `SELECT name, installed_version IS NOT NULL AS installed
           FROM pg_available_extensions WHERE name = ANY($1::text[])`,
        [...WRAPPERS],
      ),
      prisma.$queryRawUnsafe<Row[]>(`
        SELECT s.srvname AS name, w.fdwname AS wrapper, s.srvoptions AS options,
               um.umoptions AS mapping_options, um.umid IS NOT NULL AS has_mapping,
               (SELECT count(*)::int FROM pg_foreign_table ft WHERE ft.ftserver = s.oid) AS foreign_tables
          FROM pg_foreign_server s
          JOIN pg_foreign_data_wrapper w ON w.oid = s.srvfdw
          LEFT JOIN pg_user_mappings um ON um.srvid = s.oid AND um.usename = current_user
         ORDER BY s.srvname
      `),
      prisma.$queryRawUnsafe<Row[]>(`
        SELECT n.nspname AS schema, c.relname AS name, s.srvname AS server, ft.ftoptions AS options,
               (SELECT count(*)::int FROM pg_attribute a
                 WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
          FROM pg_foreign_table ft
          JOIN pg_class c ON c.oid = ft.ftrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_foreign_server s ON s.oid = ft.ftserver
         ORDER BY n.nspname, c.relname
      `),
    ]);

    const byName = new Map(available.map(row => [String(row.name), Boolean(row.installed)]));
    const secrets = await this.vaultSecretIds(servers.map(row => String(row.name)));

    return {
      wrappers: WRAPPERS.map(name => ({ name, available: byName.has(name), installed: byName.get(name) ?? false })),
      servers: servers.map(row => ({
        name: String(row.name),
        wrapper: String(row.wrapper),
        options: parseOptions(row.options),
        hasUserMapping: Boolean(row.has_mapping),
        remoteUser: parseOptions(row.mapping_options).user ?? null,
        vaultSecretId: secrets.get(String(row.name)) ?? null,
        foreignTables: Number(row.foreign_tables ?? 0),
      })),
      tables: tables.map(row => ({
        schema: String(row.schema),
        name: String(row.name),
        server: String(row.server),
        options: parseOptions(row.options),
        columns: Number(row.columns ?? 0),
      })),
    };
  }

  async enable(wrapper: WrapperName): Promise<void> {
    const { wrappers } = await this.list();
    if (!wrappers.find(w => w.name === wrapper)?.available) {
      throw new HttpException(`${wrapper} is not available in this database image.`, 400);
    }
    await this.run(this.di.prisma, `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(wrapper)}`);
  }

  async createServer(input: CreateServerInput): Promise<ForeignServerInfo> {
    const name = input.name;
    quoteIdent(name);
    for (const key of Object.keys(input.options)) {
      if (MAPPING_ONLY_OPTIONS.has(key)) {
        throw new HttpException(`"${key}" belongs to the credentials, not to the server options.`, 400);
      }
    }
    if (input.wrapper === 'file_fdw' && (input.user || input.password)) {
      throw new HttpException('file_fdw reads a file on the database server and takes no credentials.', 400);
    }
    await this.enable(input.wrapper);
    if ((await this.list()).servers.some(s => s.name === name)) {
      throw new HttpException(`Foreign server "${name}" already exists`, 409);
    }

    await this.di.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(QUIET_TRANSACTION_SQL);
      await this.run(
        tx,
        `CREATE SERVER ${quoteIdent(name)} FOREIGN DATA WRAPPER ${quoteIdent(input.wrapper)}${optionsClause(input.options)}`,
      );
      if (input.wrapper === 'postgres_fdw') {
        await this.run(
          tx,
          `CREATE USER MAPPING FOR CURRENT_USER SERVER ${quoteIdent(name)}` +
            optionsClause({ user: input.user ?? '', password: input.password ?? '' }),
        );
      }
    });
    // After the server exists, so a failed CREATE SERVER leaves no orphan secret.
    if (input.password) await this.storeCredential(name, input.password);
    return this.getServer(name);
  }

  /** Rotate a server's credentials: the Vault secret and the user mapping, together. */
  async setCredentials(name: string, credentials: { user: string; password: string }): Promise<ForeignServerInfo> {
    const server = await this.getServer(name);
    if (server.wrapper !== 'postgres_fdw') {
      throw new HttpException(`${server.wrapper} servers take no credentials.`, 400);
    }
    const options = { user: credentials.user, password: credentials.password };
    const sql = server.hasUserMapping
      ? `ALTER USER MAPPING FOR CURRENT_USER SERVER ${quoteIdent(name)}${optionsClause(
          options,
          // SET needs the option to exist already; a mapping made without a
          // password gets ADD for it instead.
          server.remoteUser === null ? 'ADD' : 'SET',
        )}`
      : `CREATE USER MAPPING FOR CURRENT_USER SERVER ${quoteIdent(name)}${optionsClause(options)}`;
    await this.di.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(QUIET_TRANSACTION_SQL);
      await this.run(tx, sql);
    });
    await this.storeCredential(name, credentials.password);
    return this.getServer(name);
  }

  async importSchema(server: string, input: ImportSchemaInput): Promise<ForeignTableInfo[]> {
    await this.getServer(server);
    await this.di.prisma.$transaction(async tx => {
      await this.run(tx, `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(input.localSchema)}`);
      await this.run(tx, importSchemaSql(server, input));
    });
    return (await this.list()).tables.filter(t => t.server === server && t.schema === input.localSchema);
  }

  async createForeignTable(input: CreateForeignTableInput): Promise<ForeignTableInfo> {
    await this.getServer(input.server);
    if (!input.columns.length) throw new HttpException('A foreign table needs at least one column.', 400);
    const columns = input.columns
      .map(column => `${quoteIdent(column.name)} ${assertSafeColumnType(column.type)}`)
      .join(', ');
    await this.di.prisma.$transaction(async tx => {
      await this.run(tx, `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(input.schema)}`);
      await this.run(
        tx,
        `CREATE FOREIGN TABLE ${quoteIdent(input.schema)}.${quoteIdent(input.name)} (${columns}) ` +
          `SERVER ${quoteIdent(input.server)}${optionsClause(input.options)}`,
      );
    });
    const table = (await this.list()).tables.find(t => t.schema === input.schema && t.name === input.name);
    if (!table) throw new HttpException('Foreign table created but not found', 500);
    return table;
  }

  /** Drops the server with its mapping and foreign tables, and its Vault secret. */
  async dropServer(name: string): Promise<void> {
    const server = await this.getServer(name);
    await this.run(this.di.prisma, `DROP SERVER ${quoteIdent(name)} CASCADE`);
    if (server.vaultSecretId) await this.di.VaultService.remove(server.vaultSecretId);
  }

  async dropForeignTable(schema: string, name: string): Promise<void> {
    const exists = (await this.list()).tables.some(t => t.schema === schema && t.name === name);
    if (!exists) throw new HttpException(`Foreign table ${schema}.${name} not found`, 404);
    await this.run(this.di.prisma, `DROP FOREIGN TABLE ${quoteIdent(schema)}.${quoteIdent(name)}`);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async getServer(name: string): Promise<ForeignServerInfo> {
    const server = (await this.list()).servers.find(s => s.name === name);
    if (!server) throw new HttpException(`Foreign server "${name}" not found`, 404);
    return server;
  }

  private async storeCredential(server: string, password: string): Promise<void> {
    await this.di.VaultService.upsertByName(
      credentialSecretName(server),
      password,
      `Password for foreign server "${server}" (Wrappers)`,
    );
  }

  /** Vault secret ids by server name. A project that never enabled the Vault has none. */
  private async vaultSecretIds(servers: string[]): Promise<Map<string, string>> {
    if (!servers.length) return new Map();
    const { secrets } = await this.di.VaultService.list();
    const byName = new Map(secrets.map(secret => [secret.name, secret.id]));
    return new Map(
      servers.flatMap(server => {
        const id = byName.get(credentialSecretName(server));
        return id ? [[server, id] as const] : [];
      }),
    );
  }

  private async run(executor: DdlExecutor, sql: string): Promise<void> {
    try {
      await execDdl(executor, sql);
    } catch (err) {
      // The statement is never echoed: a user mapping's carries the password.
      throw new HttpException(formatSqlError(err) || 'Foreign data wrapper operation failed', 400);
    } finally {
      invalidateCatalog();
    }
  }
}
