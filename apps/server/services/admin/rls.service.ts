import BaseContext from '../../context/base-context';
import { HttpException } from '../../exceptions/http-exception';
import type { Prisma } from '@prisma/client';
import { quoteIdent } from './schema-ddl';
import {
  ACCESS_COMMANDS,
  ACCESS_ROLES,
  roleAccess,
  type AccessCommand,
  type AccessRole,
  type TableAccess,
} from './rls-access';

const COMMANDS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL']);
const ROLES = new Set(['anon', 'authenticated']);

export interface PgPolicy {
  name: string;
  command: string;
  roles: string[];
  using: string | null;
  withCheck: string | null;
  /** False for AS RESTRICTIVE: such a policy can only narrow what the permissive ones allow. */
  permissive: boolean;
}
export interface PolicyDdlInput {
  table: string;
  name: string;
  command: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL';
  role: 'anon' | 'authenticated';
  using?: string;
  check?: string;
}

export const RLS_POLICY_PRESETS = [
  'starter',
  'public_crud',
  'authenticated_crud',
  'admin_only',
  'blocked',
  'owner_only',
  'org_scoped',
  'public_read_owner_write',
  'soft_delete',
] as const;

export type RlsPolicyPreset = (typeof RLS_POLICY_PRESETS)[number];

/**
 * The four presets below are parameterised rather than fixed strings, because
 * the column that carries ownership is a per-schema decision (`owner_id`,
 * `user_id`, `created_by`) and a preset that hard-codes one name is a preset
 * most tables cannot use.
 *
 * Column names reach SQL through `quoteIdent()`, so a name that is not a plain
 * identifier is refused before any DDL is built.
 */
export interface RlsPresetOptions {
  /** Column holding the owning user id. Compared against auth.uid(). */
  ownerColumn?: string;
  /** Column holding the tenant id. Compared against the JWT claim below. */
  orgColumn?: string;
  /** JWT claim carrying the caller's tenant id. */
  orgClaim?: string;
  /** Nullable timestamp column. Rows with a value set are treated as deleted. */
  deletedColumn?: string;
}

const PRESET_DEFAULTS: Required<RlsPresetOptions> = {
  ownerColumn: 'owner_id',
  orgColumn: 'org_id',
  orgClaim: 'org_id',
  deletedColumn: 'deleted_at',
};

/**
 * The claim is a literal inside the policy expression, so it is single-quoted
 * with doubling rather than passed as a parameter: policy bodies are DDL and
 * cannot carry bind parameters.
 */
function claimLiteral(claim: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(claim)) {
    throw new HttpException(`Invalid JWT claim name: ${claim}`, 400);
  }
  return `'${claim}'`;
}

type DataApiRole = PolicyDdlInput['role'];
type TablePrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

const CRUD_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
const COMMAND_PRIVILEGES: Record<PolicyDdlInput['command'], readonly TablePrivilege[]> = {
  SELECT: ['SELECT'],
  INSERT: ['INSERT'],
  UPDATE: ['UPDATE'],
  DELETE: ['DELETE'],
  ALL: CRUD_PRIVILEGES,
};

const PRESET_GRANTS: Record<RlsPolicyPreset, Partial<Record<DataApiRole, readonly TablePrivilege[]>>> = {
  starter: { anon: ['SELECT'], authenticated: CRUD_PRIVILEGES },
  public_crud: { anon: CRUD_PRIVILEGES, authenticated: CRUD_PRIVILEGES },
  authenticated_crud: { authenticated: CRUD_PRIVILEGES },
  admin_only: { authenticated: CRUD_PRIVILEGES },
  blocked: {},
  owner_only: { authenticated: CRUD_PRIVILEGES },
  org_scoped: { authenticated: CRUD_PRIVILEGES },
  public_read_owner_write: { anon: ['SELECT'], authenticated: CRUD_PRIVILEGES },
  soft_delete: { anon: ['SELECT'], authenticated: CRUD_PRIVILEGES },
};

/**
 * Presets whose expressions depend on a caller-supplied column. Kept separate
 * from the static table below so the static ones stay readable.
 */
const PARAMETERISED_POLICIES: Partial<
  Record<RlsPolicyPreset, (o: Required<RlsPresetOptions>) => ReadonlyArray<Omit<PolicyDdlInput, 'table'>>>
> = {
  owner_only: o => {
    const owner = quoteIdent(o.ownerColumn);
    return [
      {
        name: 'owner_only',
        command: 'ALL',
        role: 'authenticated',
        // WITH CHECK matters as much as USING here: without it a caller could
        // update a row they own into one owned by somebody else.
        using: `${owner} = auth.uid()`,
        check: `${owner} = auth.uid()`,
      },
    ];
  },
  org_scoped: o => {
    const org = quoteIdent(o.orgColumn);
    const claim = claimLiteral(o.orgClaim);
    const value = `((select auth.jwt()) ->> ${claim})`;
    return [
      {
        name: 'org_scoped',
        command: 'ALL',
        role: 'authenticated',
        using: `${org} = ${value}`,
        check: `${org} = ${value}`,
      },
    ];
  },
  public_read_owner_write: o => {
    const owner = quoteIdent(o.ownerColumn);
    return [
      { name: 'public_read_owner_write_read_anon', command: 'SELECT', role: 'anon', using: 'true' },
      { name: 'public_read_owner_write_read', command: 'SELECT', role: 'authenticated', using: 'true' },
      {
        name: 'public_read_owner_write_insert',
        command: 'INSERT',
        role: 'authenticated',
        check: `${owner} = auth.uid()`,
      },
      {
        name: 'public_read_owner_write_update',
        command: 'UPDATE',
        role: 'authenticated',
        using: `${owner} = auth.uid()`,
        check: `${owner} = auth.uid()`,
      },
      {
        name: 'public_read_owner_write_delete',
        command: 'DELETE',
        role: 'authenticated',
        using: `${owner} = auth.uid()`,
      },
    ];
  },
  soft_delete: o => {
    const deleted = quoteIdent(o.deletedColumn);
    const alive = `${deleted} IS NULL`;
    // A caller cannot mark a row deleted with a plain UPDATE under these
    // policies, and no arrangement of them can change that: when an UPDATE needs
    // read access (any WHERE clause does), Postgres applies the SELECT policy to
    // the NEW row as well as the old one, so the row disappears mid-statement and
    // the write fails with `new row violates row-level security policy`.
    //
    // That is why this preset also installs a BEFORE DELETE trigger (see
    // `installSoftDelete`): the caller issues an ordinary DELETE, the trigger
    // turns it into the timestamp write. The delete policy still decides which
    // rows are reachable, so the trigger cannot touch a row the caller could not
    // have deleted anyway.
    return [
      { name: 'soft_delete_read_anon', command: 'SELECT', role: 'anon', using: alive },
      { name: 'soft_delete_read', command: 'SELECT', role: 'authenticated', using: alive },
      { name: 'soft_delete_insert', command: 'INSERT', role: 'authenticated', check: 'true' },
      { name: 'soft_delete_update', command: 'UPDATE', role: 'authenticated', using: alive, check: alive },
      { name: 'soft_delete_delete', command: 'DELETE', role: 'authenticated', using: alive },
    ];
  },
};

const PRESET_POLICIES: Record<RlsPolicyPreset, ReadonlyArray<Omit<PolicyDdlInput, 'table'>>> = {
  starter: [
    { name: 'starter_public_read', command: 'SELECT', role: 'anon', using: 'true' },
    { name: 'starter_authenticated_crud', command: 'ALL', role: 'authenticated', using: 'true', check: 'true' },
  ],
  public_crud: [
    { name: 'public_crud_anon', command: 'ALL', role: 'anon', using: 'true', check: 'true' },
    { name: 'public_crud_authenticated', command: 'ALL', role: 'authenticated', using: 'true', check: 'true' },
  ],
  authenticated_crud: [
    { name: 'authenticated_crud', command: 'ALL', role: 'authenticated', using: 'true', check: 'true' },
  ],
  admin_only: [
    {
      name: 'admin_only',
      command: 'ALL',
      role: 'authenticated',
      using: "(select auth.jwt()) ->> 'user_role' = 'ADMIN'",
      check: "(select auth.jwt()) ->> 'user_role' = 'ADMIN'",
    },
  ],
  blocked: [],
  // Filled in by PARAMETERISED_POLICIES; the static table only exists so every
  // preset name has an entry and the Record type stays exhaustive.
  owner_only: [],
  org_scoped: [],
  public_read_owner_write: [],
  soft_delete: [],
};

export function parseRlsPolicyPreset(value: unknown): RlsPolicyPreset {
  if (typeof value === 'string' && RLS_POLICY_PRESETS.includes(value as RlsPolicyPreset)) {
    return value as RlsPolicyPreset;
  }
  throw new HttpException(`policyPreset must be one of: ${RLS_POLICY_PRESETS.join(', ')}`, 400);
}

export function policiesForPreset(
  table: string,
  preset: RlsPolicyPreset,
  options: RlsPresetOptions = {}
): PolicyDdlInput[] {
  const build = PARAMETERISED_POLICIES[preset];
  const definitions = build ? build({ ...PRESET_DEFAULTS, ...options }) : PRESET_POLICIES[preset];
  return definitions.map(policy => ({ ...policy, table }));
}

type SqlExecutor = Pick<Prisma.TransactionClient, '$executeRawUnsafe' | '$queryRawUnsafe'>;

/**
 * The one non-public table Studio writes policies for: Realtime Authorization
 * reads them to decide who may join a private channel (see
 * RealtimeAuthorizationService). Fixed here, never taken from a request.
 */
const REALTIME_MESSAGES = '"realtime"."messages"';

export type RealtimePolicyInput = Omit<PolicyDdlInput, 'table'>;

function toPgPolicy(row: any): PgPolicy {
  return {
    name: row.policyname,
    command: row.cmd,
    roles: Array.isArray(row.roles) ? row.roles : String(row.roles).replace(/[{}]/g, '').split(','),
    using: row.qual ?? null,
    withCheck: row.with_check ?? null,
    permissive: row.permissive !== 'RESTRICTIVE',
  };
}

function policySql(input: PolicyDdlInput, table = quoteIdent(input.table)): string {
  const name = quoteIdent(input.name);
  if (!COMMANDS.has(input.command)) throw new HttpException('Invalid policy command', 400);
  if (!ROLES.has(input.role)) throw new HttpException('Invalid RLS role', 400);
  const parts = [`CREATE POLICY ${name} ON ${table}`, `FOR ${input.command}`, `TO ${input.role}`];
  if (input.using?.trim()) parts.push(`USING (${input.using.trim()})`);
  if (input.check?.trim()) parts.push(`WITH CHECK (${input.check.trim()})`);
  return parts.join(' ');
}

export class RlsService extends BaseContext {
  async listTables(): Promise<Array<{ table: string; rlsEnabled: boolean; policies: PgPolicy[] }>> {
    const tables = await this.di.prisma.$queryRawUnsafe<any[]>(
      `SELECT c.relname AS table, c.relrowsecurity AS rls
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE '\\_prisma\\_%'
        ORDER BY c.relname`
    );
    const pols = await this.di.prisma.$queryRawUnsafe<any[]>(
      `SELECT tablename, policyname, cmd, roles, qual, with_check, permissive
         FROM pg_policies WHERE schemaname = 'public'`
    );
    return tables.map(t => ({
      table: t.table,
      rlsEnabled: Boolean(t.rls),
      policies: pols.filter(p => p.tablename === t.table).map(toPgPolicy),
    }));
  }

  /** Policies on `realtime.messages`: who may receive and send on private channels. */
  async listRealtimePolicies(): Promise<PgPolicy[]> {
    const rows = await this.di.prisma.$queryRawUnsafe<any[]>(
      `SELECT policyname, cmd, roles, qual, with_check, permissive
         FROM pg_policies WHERE schemaname = 'realtime' AND tablename = 'messages'
        ORDER BY policyname`
    );
    return rows.map(toPgPolicy);
  }

  /**
   * No grants here, unlike `createPolicy`: the migration that created the
   * table already granted SELECT and INSERT, and those are the only commands
   * Realtime Authorization checks.
   */
  async createRealtimePolicy(input: RealtimePolicyInput): Promise<void> {
    await this.di.prisma.$executeRawUnsafe(policySql({ ...input, table: 'messages' }, REALTIME_MESSAGES));
  }

  async dropRealtimePolicy(name: string): Promise<void> {
    await this.di.prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS ${quoteIdent(name)} ON ${REALTIME_MESSAGES}`);
  }

  /**
   * What `anon` and `authenticated` can do to each table, per command. Read
   * from grants and policies alone, so it answers for every table at once and
   * needs no query from the caller; see `rls-access.ts` for the rules.
   */
  async accessMatrix(): Promise<TableAccess[]> {
    const tables = await this.listTables();
    // `has_*_privilege` rather than `role_table_grants`: it also counts grants
    // to PUBLIC, inherited roles, and column-level grants, which all let the
    // statement through just as well.
    const grants = await this.di.prisma.$queryRawUnsafe<
      Array<{ table: string; role: AccessRole } & Record<AccessCommand, boolean>>
    >(
      `SELECT c.relname AS "table", r.role,
              has_any_column_privilege(r.role, c.oid, 'SELECT') AS "SELECT",
              has_any_column_privilege(r.role, c.oid, 'INSERT') AS "INSERT",
              has_any_column_privilege(r.role, c.oid, 'UPDATE') AS "UPDATE",
              has_table_privilege(r.role, c.oid, 'DELETE') AS "DELETE"
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN unnest($1::text[]) AS r(role)
        WHERE n.nspname = 'public' AND c.relname = ANY($2::text[])`,
      ACCESS_ROLES,
      tables.map(t => t.table)
    );

    const privileges = (table: string, role: AccessRole): AccessCommand[] => {
      const row = grants.find(g => g.table === table && g.role === role);
      return ACCESS_COMMANDS.filter(command => row?.[command]);
    };

    return tables.map(({ table, rlsEnabled, policies }) => {
      const facts = {
        rlsEnabled,
        policies,
        privileges: { anon: privileges(table, 'anon'), authenticated: privileges(table, 'authenticated') },
      };
      return {
        table,
        rlsEnabled,
        access: { anon: roleAccess(facts, 'anon'), authenticated: roleAccess(facts, 'authenticated') },
      };
    });
  }

  async setRls(table: string, enabled: boolean, executor: SqlExecutor = this.di.prisma): Promise<void> {
    const t = quoteIdent(table);
    await executor.$executeRawUnsafe(`ALTER TABLE ${t} ${enabled ? 'ENABLE' : 'DISABLE'} ROW LEVEL SECURITY`);
  }

  async createPolicy(input: PolicyDdlInput, executor: SqlExecutor = this.di.prisma): Promise<void> {
    await this.createPolicyDefinition(input, executor);
    const privileges = COMMAND_PRIVILEGES[input.command];
    const sequences = privileges.includes('INSERT') ? await this.ownedSequences(input.table, executor) : [];
    await this.grantPrivileges(input.table, input.role, privileges, sequences, executor);
  }

  async applyPreset(
    table: string,
    preset: RlsPolicyPreset,
    executor: SqlExecutor = this.di.prisma,
    options: RlsPresetOptions = {}
  ): Promise<void> {
    await this.setRls(table, true, executor);
    const tableName = quoteIdent(table);
    const sequences = await this.ownedSequences(table, executor);

    await executor.$executeRawUnsafe(`REVOKE ALL PRIVILEGES ON TABLE ${tableName} FROM anon, authenticated`);
    for (const { name } of sequences) {
      await executor.$executeRawUnsafe(`REVOKE ALL PRIVILEGES ON SEQUENCE ${quoteIdent(name)} FROM anon, authenticated`);
    }

    for (const role of ['anon', 'authenticated'] as const) {
      const privileges = PRESET_GRANTS[preset][role];
      if (!privileges?.length) continue;
      await this.grantPrivileges(table, role, privileges, sequences, executor);
    }

    for (const policy of policiesForPreset(table, preset, options)) {
      await this.createPolicyDefinition(policy, executor);
    }

    if (preset === 'soft_delete') {
      await this.installSoftDelete(table, { ...PRESET_DEFAULTS, ...options }.deletedColumn, executor);
    }
  }

  /**
   * Turns DELETE into a timestamp write for the `soft_delete` preset.
   *
   * SECURITY DEFINER is load-bearing and safe here for one reason: the trigger
   * only ever fires for rows the DELETE policy already let through, and it can
   * only write the one column, on the one row (matched by ctid, so the table
   * needs no primary key). It cannot be called directly, because a trigger
   * function takes no arguments and returns a trigger type.
   */
  private async installSoftDelete(table: string, column: string, executor: SqlExecutor): Promise<void> {
    const t = quoteIdent(table);
    const col = quoteIdent(column);
    const fn = quoteIdent(`${table}_soft_delete`);
    await executor.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
      AS $soft$
      BEGIN
        UPDATE ${t} SET ${col} = now() WHERE ctid = OLD.ctid;
        RETURN NULL;
      END
      $soft$
    `);
    await executor.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON ${t}`);
    await executor.$executeRawUnsafe(
      `CREATE TRIGGER ${fn} BEFORE DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION ${fn}()`
    );
  }

  /** Any other preset must not leave a previous soft-delete trigger swallowing deletes. */
  private async dropSoftDelete(table: string, executor: SqlExecutor): Promise<void> {
    const t = quoteIdent(table);
    const fn = quoteIdent(`${table}_soft_delete`);
    await executor.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON ${t}`);
    await executor.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
  }

  /**
   * Apply a preset to a table that already exists. `applyPreset` assumes a fresh
   * table: it creates policies without dropping anything, so running it twice
   * fails on the duplicate name. Replacing what is there is destructive enough
   * to be asked for explicitly rather than inferred.
   */
  async applyPresetToTable(
    table: string,
    preset: RlsPolicyPreset,
    options: RlsPresetOptions & { replace?: boolean } = {}
  ): Promise<{ policies: string[] }> {
    const existing = await this.di.prisma.$queryRawUnsafe<Array<{ policyname: string }>>(
      `SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
      table
    );
    if (existing.length && !options.replace) {
      throw new HttpException(
        `${table} already has ${existing.length} policies. Pass replace: true to drop them first.`,
        409
      );
    }
    for (const { policyname } of existing) await this.dropPolicy(table, policyname);
    // Only the existing-table path can be replacing a soft-delete preset, and a
    // leftover trigger would silently swallow every delete under the new one.
    await this.dropSoftDelete(table, this.di.prisma);
    await this.applyPreset(table, preset, this.di.prisma, options);
    return { policies: policiesForPreset(table, preset, options).map(p => p.name) };
  }

  private async ownedSequences(table: string, executor: SqlExecutor): Promise<Array<{ name: string }>> {
    quoteIdent(table);
    return executor.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT sequence.relname AS name
         FROM pg_class table_rel
         JOIN pg_namespace table_ns ON table_ns.oid = table_rel.relnamespace
         JOIN pg_depend dependency
           ON dependency.refobjid = table_rel.oid
          AND dependency.refclassid = 'pg_class'::regclass
          AND dependency.deptype IN ('a', 'i')
         JOIN pg_class sequence
           ON sequence.oid = dependency.objid
          AND sequence.relkind = 'S'
         JOIN pg_namespace sequence_ns ON sequence_ns.oid = sequence.relnamespace
        WHERE table_ns.nspname = 'public'
          AND table_rel.relname = $1
          AND sequence_ns.nspname = 'public'`,
      table
    );
  }

  private async grantPrivileges(
    table: string,
    role: DataApiRole,
    privileges: readonly TablePrivilege[],
    sequences: Array<{ name: string }>,
    executor: SqlExecutor
  ): Promise<void> {
    if (!privileges.length) return;
    await executor.$executeRawUnsafe(`GRANT ${privileges.join(', ')} ON TABLE ${quoteIdent(table)} TO ${role}`);
    if (!privileges.includes('INSERT')) return;
    for (const { name } of sequences) {
      await executor.$executeRawUnsafe(`GRANT USAGE ON SEQUENCE ${quoteIdent(name)} TO ${role}`);
    }
  }

  private async createPolicyDefinition(input: PolicyDdlInput, executor: SqlExecutor): Promise<void> {
    await executor.$executeRawUnsafe(policySql(input));
  }

  /** Grants remain after a policy is dropped; enabled RLS still denies access without a matching policy. */
  async dropPolicy(table: string, name: string): Promise<void> {
    await this.di.prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS ${quoteIdent(name)} ON ${quoteIdent(table)}`);
  }

  /** Edit = drop + recreate (Postgres has no general ALTER POLICY for USING change of role/cmd). */
  async replacePolicy(prevName: string, input: PolicyDdlInput): Promise<void> {
    await this.dropPolicy(input.table, prevName);
    await this.createPolicy(input);
  }
}
