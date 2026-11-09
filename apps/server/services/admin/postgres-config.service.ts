import prisma from '../../lib/prisma';
import { HttpException } from '../../exceptions/http-exception';
import {
  configStatement,
  defaultScope,
  explainPgFailure,
  settingScopes,
  type ConfigScope,
} from './database-ddl';

/**
 * The settings the console exposes, and the only ones it will write.
 *
 * This is Supabase's `postgres-config` list plus the session timeouts people
 * actually tune. Anything that changes durability or security (`fsync`,
 * `ssl`, `listen_addresses`, `shared_preload_libraries`) is deliberately out:
 * a wrong value there does not make the database slow, it makes it unsafe or
 * unbootable, and it belongs in the deployment, not a form.
 */
export const CURATED_SETTINGS = [
  'statement_timeout',
  'idle_in_transaction_session_timeout',
  'idle_session_timeout',
  'lock_timeout',
  'work_mem',
  'maintenance_work_mem',
  'effective_cache_size',
  'random_page_cost',
  'log_min_duration_statement',
  'session_replication_role',
  'max_parallel_workers',
  'max_parallel_workers_per_gather',
  'max_parallel_maintenance_workers',
  'logical_decoding_work_mem',
  'wal_sender_timeout',
  'max_wal_size',
  'wal_keep_size',
  'max_slot_wal_keep_size',
  'checkpoint_timeout',
  'max_connections',
  'shared_buffers',
  'max_worker_processes',
  'max_locks_per_transaction',
  'max_replication_slots',
  'max_wal_senders',
  'track_activity_query_size',
  'track_commit_timestamp',
] as const;

const CURATED = new Set<string>(CURATED_SETTINGS);

export interface ConfigOverride {
  scope: ConfigScope;
  role?: string;
  value: string;
}

export interface PostgresSetting {
  name: string;
  /** `current_setting()`: the effective value with its unit, e.g. `4MB`. */
  value: string;
  unit: string | null;
  vartype: string;
  context: string;
  category: string;
  description: string;
  min: string | null;
  max: string | null;
  enumValues: string[] | null;
  bootValue: string | null;
  /** Changed with ALTER SYSTEM but only applied by a server restart. */
  pendingRestart: boolean;
  scopes: ConfigScope[];
  overrides: ConfigOverride[];
}

export interface PostgresConfig {
  database: string;
  version: string;
  settings: PostgresSetting[];
  /** ALTER SYSTEM needs superuser; without it only database/role scopes work. */
  canAlterSystem: boolean;
  /**
   * False when this role cannot read `pg_file_settings`, so system overrides
   * could not be listed. Never report an unread list as empty.
   */
  systemOverridesReadable: boolean;
}

export interface ConfigChange {
  name: string;
  /** null resets the override. */
  value: string | null;
  scope?: ConfigScope;
  role?: string;
}

export interface ConfigChangeResult {
  applied: Array<{ name: string; scope: ConfigScope; role?: string }>;
  /** Settings whose new value waits for a Postgres restart. */
  restartRequired: string[];
}

interface SettingRow {
  name: string;
  value: string;
  unit: string | null;
  vartype: string;
  context: string;
  category: string;
  short_desc: string;
  min_val: string | null;
  max_val: string | null;
  enumvals: string[] | null;
  boot_val: string | null;
  pending_restart: boolean;
}

/**
 * Postgres configuration (Database > Settings, `motherbase postgres-config`).
 *
 * Writes pick the narrowest scope the setting allows unless told otherwise:
 * `statement_timeout` becomes `ALTER DATABASE ... SET`, which new sessions pick
 * up immediately and which a `pg_dump` of the database carries along, while
 * `shared_buffers` can only be `ALTER SYSTEM`, followed by a reload. A setting
 * whose context is `postmaster` still needs a restart after that; the result
 * says so rather than restarting a database the API is running on.
 */
export class PostgresConfigService {
  constructor(_di: unknown) {}

  async get(): Promise<PostgresConfig> {
    const [[meta], rows, dbOverrides, system] = await Promise.all([
      prisma.$queryRawUnsafe<Array<{ database: string; version: string; superuser: boolean }>>(`
        SELECT current_database() AS database, current_setting('server_version') AS version,
               (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser
      `),
      prisma.$queryRawUnsafe<SettingRow[]>(`
        SELECT name, current_setting(name) AS value, unit, vartype, context, category, short_desc,
               min_val, max_val, enumvals, boot_val, pending_restart
        FROM pg_settings
        WHERE name = ANY($1::text[])
      `, [...CURATED_SETTINGS]),
      prisma.$queryRawUnsafe<Array<{ role: string | null; config: string[] }>>(`
        SELECT CASE WHEN s.setrole = 0 THEN NULL ELSE pg_get_userbyid(s.setrole) END AS role, s.setconfig AS config
        FROM pg_db_role_setting s
        WHERE s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
           OR (s.setdatabase = 0 AND s.setrole <> 0)
      `),
      this.systemOverrides(),
    ]);

    const overrides = new Map<string, ConfigOverride[]>();
    const add = (name: string, override: ConfigOverride) => overrides.set(name, [...(overrides.get(name) ?? []), override]);
    for (const { role, config } of dbOverrides) {
      for (const entry of config) {
        const at = entry.indexOf('=');
        const name = entry.slice(0, at);
        if (!CURATED.has(name)) continue;
        add(name, role ? { scope: 'role', role, value: entry.slice(at + 1) } : { scope: 'database', value: entry.slice(at + 1) });
      }
    }
    for (const { name, value } of system ?? []) add(name, { scope: 'system', value });

    // Keep the curated order: it groups timeouts, memory, then restart-only ones.
    const byName = new Map(rows.map(row => [row.name, row]));
    const settings = CURATED_SETTINGS.flatMap(name => {
      const row = byName.get(name);
      if (!row) return [];
      return [{
        name,
        value: row.value,
        unit: row.unit,
        vartype: row.vartype,
        context: row.context,
        category: row.category,
        description: row.short_desc,
        min: row.min_val,
        max: row.max_val,
        enumValues: row.enumvals,
        bootValue: row.boot_val,
        pendingRestart: row.pending_restart,
        scopes: settingScopes(row.context),
        overrides: overrides.get(name) ?? [],
      }];
    });

    return {
      database: meta.database,
      version: meta.version,
      settings,
      canAlterSystem: meta.superuser,
      systemOverridesReadable: system !== null,
    };
  }

  /**
   * Apply several changes at once, like `postgres-config update --config a=1
   * --config b=2`. Database and role changes run in one transaction; ALTER
   * SYSTEM cannot run inside one, so those run after, each on its own.
   */
  async update(changes: ConfigChange[]): Promise<ConfigChangeResult> {
    const current = await this.get();
    const settings = new Map(current.settings.map(setting => [setting.name, setting]));

    const planned = changes.map(change => {
      const setting = settings.get(change.name);
      if (!setting) throw new HttpException(`"${change.name}" is not a setting the console manages`, 400);
      const scope = change.scope ?? defaultScope(setting.context);
      if (!setting.scopes.includes(scope)) {
        throw new HttpException(`${change.name} can only be set server-wide (scope "system")`, 400);
      }
      if (scope === 'system' && !current.canAlterSystem) {
        throw new HttpException(`Changing ${change.name} needs ALTER SYSTEM, which requires a superuser connection`, 403);
      }
      const statement = configStatement({ scope, name: change.name, database: current.database, role: change.role }, change.value);
      return { change, setting, scope, statement };
    });

    const inTransaction = planned.filter(plan => plan.scope !== 'system');
    const system = planned.filter(plan => plan.scope === 'system');

    await explainPgFailure(async () => {
      if (inTransaction.length) {
        await prisma.$transaction(async tx => {
          for (const plan of inTransaction) await tx.$executeRawUnsafe(plan.statement);
        });
      }
      for (const plan of system) await prisma.$executeRawUnsafe(plan.statement);
      if (system.length) await prisma.$queryRawUnsafe(`SELECT pg_reload_conf()`);
    });

    return {
      applied: planned.map(({ change, scope }) => ({ name: change.name, scope, ...(scope === 'role' ? { role: change.role } : {}) })),
      restartRequired: system.filter(plan => plan.setting.context === 'postmaster').map(plan => plan.change.name),
    };
  }

  /** `postgresql.auto.conf` entries, or null when this role may not read them. */
  private async systemOverrides(): Promise<Array<{ name: string; value: string }> | null> {
    try {
      return await prisma.$queryRawUnsafe<Array<{ name: string; value: string }>>(`
        SELECT name, setting AS value FROM pg_file_settings
        WHERE sourcefile LIKE '%postgresql.auto.conf' AND name = ANY($1::text[])
        ORDER BY seqno
      `, [...CURATED_SETTINGS]);
    } catch {
      return null;
    }
  }
}
