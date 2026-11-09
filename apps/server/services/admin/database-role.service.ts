import prisma from '../../lib/prisma';
import { HttpException } from '../../exceptions/http-exception';
import { assertSchema, execDdl, qualified, quoteIdent } from './schema-ddl';
import {
  columnPrivilegeStatements,
  COLUMN_PRIVILEGES,
  explainPgFailure,
  reservedRoleReason,
  roleOptionsSql,
  type ColumnPrivilege,
  type RoleAttributes,
} from './database-ddl';

export interface DatabaseRoleInfo {
  name: string;
  canLogin: boolean;
  isSuperuser: boolean;
  canCreateDb: boolean;
  canCreateRole: boolean;
  canReplicate: boolean;
  canBypassRls: boolean;
  inheritRole: boolean;
  /** -1 means unlimited. */
  connectionLimit: number;
  validUntil: string | null;
  activeConnections: number;
  memberOf: string[];
  comment: string | null;
  /** Set when the console refuses to change this role, with the reason. */
  reserved: string | null;
}

export interface CreateRoleInput extends RoleAttributes {
  name: string;
}

export interface UpdateRoleInput extends RoleAttributes {
  /** New name. Postgres clears an MD5 password on rename; SCRAM ones survive. */
  name?: string;
}

export interface ColumnPrivilegeMatrix {
  table: string;
  schema: string;
  columns: string[];
  /** One entry per role that can be granted to: role -> privilege -> granted columns. */
  roles: Array<{
    role: string;
    privileges: Record<ColumnPrivilege, { tableLevel: boolean; columns: string[] }>;
  }>;
}

export interface ColumnPrivilegeInput {
  schema?: string;
  table: string;
  role: string;
  privilege: ColumnPrivilege;
  columns: string[];
  grant: boolean;
}

interface RoleRow {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  rolinherit: boolean;
  rolconnlimit: number;
  rolvaliduntil: Date | null;
  active_connections: number;
  member_of: string[] | null;
  comment: string | null;
}

/**
 * Postgres roles (Database > Roles) and their column-level grants (Database >
 * Column Privileges).
 *
 * Roles are cluster-wide, and several of them are load-bearing for this
 * platform: see `reservedRoleReason`. Those are listed with the reason and
 * refused on every write, so a console click cannot lock the server out of
 * its own database or break REST for every caller.
 */
export class DatabaseRoleService {
  constructor(_di: unknown) {}

  async list(): Promise<DatabaseRoleInfo[]> {
    const [rows, currentUser] = await Promise.all([
      prisma.$queryRawUnsafe<RoleRow[]>(`
        SELECT
          r.rolname, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
          r.rolreplication, r.rolbypassrls, r.rolinherit, r.rolconnlimit, r.rolvaliduntil,
          (SELECT count(*)::int FROM pg_stat_activity a WHERE a.usename = r.rolname) AS active_connections,
          ARRAY(
            SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
            WHERE m.member = r.oid ORDER BY g.rolname
          ) AS member_of,
          shobj_description(r.oid, 'pg_authid') AS comment
        FROM pg_roles r
        ORDER BY r.rolname
      `),
      this.currentUser(),
    ]);

    return rows.map(row => ({
      name: row.rolname,
      canLogin: row.rolcanlogin,
      isSuperuser: row.rolsuper,
      canCreateDb: row.rolcreatedb,
      canCreateRole: row.rolcreaterole,
      canReplicate: row.rolreplication,
      canBypassRls: row.rolbypassrls,
      inheritRole: row.rolinherit,
      connectionLimit: row.rolconnlimit,
      // `infinity` comes back as an Invalid Date through the driver.
      validUntil: row.rolvaliduntil && !Number.isNaN(row.rolvaliduntil.getTime()) ? row.rolvaliduntil.toISOString() : null,
      activeConnections: row.active_connections,
      memberOf: row.member_of ?? [],
      comment: row.comment,
      reserved: reservedRoleReason(row.rolname, currentUser),
    }));
  }

  async create(input: CreateRoleInput): Promise<void> {
    const { name, ...attributes } = input;
    // `pg_` is refused by Postgres itself; the rest would create a role the
    // console then refuses to edit or drop.
    const reason = reservedRoleReason(name, await this.currentUser());
    if (reason) throw new HttpException(`"${name}" is a reserved role name. ${reason}`, 400);
    const options = roleOptionsSql(attributes);
    await explainPgFailure(() => prisma.$executeRawUnsafe(`CREATE ROLE ${quoteIdent(name)}${options ? ` WITH ${options}` : ''}`));
  }

  async update(name: string, input: UpdateRoleInput): Promise<void> {
    await this.assertEditable(name);
    const { name: rename, ...attributes } = input;
    const options = roleOptionsSql(attributes);
    if (rename && rename !== name) {
      const reason = reservedRoleReason(rename, await this.currentUser());
      if (reason) throw new HttpException(`Cannot rename to "${rename}". ${reason}`, 400);
    }

    await explainPgFailure(() =>
      prisma.$transaction(async tx => {
        if (options) await tx.$executeRawUnsafe(`ALTER ROLE ${quoteIdent(name)} WITH ${options}`);
        if (rename && rename !== name) await tx.$executeRawUnsafe(`ALTER ROLE ${quoteIdent(name)} RENAME TO ${quoteIdent(rename)}`);
      }),
    );
  }

  /**
   * A role that owns objects or holds grants cannot be dropped, and Postgres
   * says which ones; that message is passed through rather than working around
   * it with REASSIGN OWNED, which would silently move someone's tables.
   */
  async drop(name: string): Promise<void> {
    await this.assertEditable(name);
    await explainPgFailure(() => prisma.$executeRawUnsafe(`DROP ROLE ${quoteIdent(name)}`));
  }

  /**
   * Which columns each grantable role holds SELECT / INSERT / UPDATE /
   * REFERENCES on, read from the ACLs themselves rather than
   * `has_column_privilege`, which also counts membership and superuser and so
   * cannot tell "granted here" from "inherited from somewhere else".
   */
  async columnPrivileges(table: string, schema?: string): Promise<ColumnPrivilegeMatrix> {
    const nsp = assertSchema(schema);
    const ref = qualified(table, nsp);
    const [columnRows, aclRows, roles] = await Promise.all([
      prisma.$queryRawUnsafe<Array<{ attname: string }>>(`
        SELECT a.attname FROM pg_attribute a
        WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `, ref),
      prisma.$queryRawUnsafe<Array<{ grantee: string; privilege: string; column: string | null }>>(`
        SELECT g.rolname AS grantee, acl.privilege_type AS privilege, NULL::text AS column
        FROM pg_class c, aclexplode(c.relacl) acl
        JOIN pg_roles g ON g.oid = acl.grantee
        WHERE c.oid = $1::regclass
        UNION ALL
        SELECT g.rolname, acl.privilege_type, a.attname
        FROM pg_attribute a, aclexplode(a.attacl) acl
        JOIN pg_roles g ON g.oid = acl.grantee
        WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
      `, ref),
      this.grantableRoles(),
    ]);

    const columns = columnRows.map(row => row.attname);
    return {
      table,
      schema: nsp,
      columns,
      roles: roles.map(role => ({
        role,
        privileges: Object.fromEntries(COLUMN_PRIVILEGES.map(privilege => {
          const mine = aclRows.filter(row => row.grantee === role && row.privilege === privilege);
          const tableLevel = mine.some(row => row.column === null);
          const granted = new Set(mine.map(row => row.column).filter((column): column is string => column !== null));
          return [privilege, { tableLevel, columns: tableLevel ? columns : columns.filter(column => granted.has(column)) }];
        })) as ColumnPrivilegeMatrix['roles'][number]['privileges'],
      })),
    };
  }

  async setColumnPrivilege(input: ColumnPrivilegeInput): Promise<ColumnPrivilegeMatrix> {
    const current = await this.columnPrivileges(input.table, input.schema);
    const unknown = input.columns.filter(column => !current.columns.includes(column));
    if (unknown.length) throw new HttpException(`Unknown column: ${unknown.join(', ')}`, 400);
    const entry = current.roles.find(role => role.role === input.role);
    if (!entry) throw new HttpException(`Role "${input.role}" cannot be granted column privileges from here`, 400);

    const statements = columnPrivilegeStatements({
      table: qualified(input.table, input.schema),
      role: input.role,
      privilege: input.privilege,
      columns: input.columns,
      grant: input.grant,
      allColumns: current.columns,
      tableLevel: entry.privileges[input.privilege].tableLevel,
    });
    // Grants change what REST may read, so they go through the DDL choke point
    // like any other schema change.
    await explainPgFailure(() =>
      prisma.$transaction(async tx => {
        for (const statement of statements) await execDdl(tx, statement);
      }),
    );
    return this.columnPrivileges(input.table, input.schema);
  }

  /**
   * The roles a column grant is meaningful for: the API roles plus any login
   * or group role an operator created. Predefined `pg_*` roles and superusers
   * (which bypass every ACL) are left out.
   */
  private async grantableRoles(): Promise<string[]> {
    const rows = await prisma.$queryRawUnsafe<Array<{ rolname: string }>>(`
      SELECT rolname FROM pg_roles
      WHERE rolname NOT LIKE 'pg\\_%' AND NOT rolsuper
      ORDER BY rolname IN ('anon', 'authenticated', 'service_role') DESC, rolname
    `);
    return rows.map(row => row.rolname);
  }

  private async assertEditable(name: string): Promise<void> {
    const reason = reservedRoleReason(name, await this.currentUser());
    if (reason) throw new HttpException(`Role "${name}" cannot be changed from the console. ${reason}`, 403);
    const exists = await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM pg_roles WHERE rolname = $1`, name);
    if (!exists.length) throw new HttpException(`Role "${name}" does not exist`, 404);
  }

  private async currentUser(): Promise<string> {
    const [row] = await prisma.$queryRawUnsafe<Array<{ current_user: string }>>(`SELECT current_user`);
    return row.current_user;
  }
}
