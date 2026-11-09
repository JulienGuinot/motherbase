import { api } from '@/shared/lib/api';

// Shapes of the Database section endpoints (admin-database.controller.ts).

export interface TableStats {
  name: string;
  kind: 'table' | 'partitioned' | 'view' | 'materialized view' | 'foreign';
  columns: number;
  /** Planner estimate; -1 until the table is first analyzed. */
  rowsEstimate: number;
  totalBytes: number;
  rlsEnabled: boolean;
  comment: string | null;
}

export const INDEX_METHODS = ['btree', 'hash', 'gist', 'gin', 'brin', 'spgist'] as const;
export type IndexMethod = (typeof INDEX_METHODS)[number];

export interface SchemaIndex {
  name: string;
  table: string;
  method: string;
  unique: boolean;
  primary: boolean;
  columns: string[];
  sizeBytes: number;
  definition: string;
}

export interface EnumType {
  schema: string;
  name: string;
  values: string[];
  comment: string | null;
  usedBy: string[];
}

export type EnumChange =
  | { action: 'add-value'; value: string; before?: string; after?: string }
  | { action: 'rename-value'; from: string; to: string }
  | { action: 'rename'; name: string };

export interface RoleAttributes {
  canLogin: boolean;
  isSuperuser: boolean;
  canCreateDb: boolean;
  canCreateRole: boolean;
  canReplicate: boolean;
  canBypassRls: boolean;
  inheritRole: boolean;
  connectionLimit: number;
}

export interface DatabaseRole extends RoleAttributes {
  name: string;
  validUntil: string | null;
  activeConnections: number;
  memberOf: string[];
  comment: string | null;
  /** Why the console will not change this role, or null. */
  reserved: string | null;
}

export type RoleWrite = Partial<RoleAttributes> & { name?: string; password?: string | null; validUntil?: string | null };

export const COLUMN_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] as const;
export type ColumnPrivilege = (typeof COLUMN_PRIVILEGES)[number];

export interface ColumnPrivilegeMatrix {
  table: string;
  schema: string;
  columns: string[];
  roles: Array<{
    role: string;
    privileges: Record<ColumnPrivilege, { tableLevel: boolean; columns: string[] }>;
  }>;
}

export interface ColumnPrivilegeChange {
  schema: string;
  table: string;
  role: string;
  privilege: ColumnPrivilege;
  columns: string[];
  grant: boolean;
}

export interface PublishActions {
  insert: boolean;
  update: boolean;
  delete: boolean;
  truncate: boolean;
}

export interface TableRef {
  schema: string;
  table: string;
}

export interface Publication extends PublishActions {
  name: string;
  owner: string;
  allTables: boolean;
  viaRoot: boolean;
  tables: TableRef[];
  /** `supabase_realtime`, carried over from a Supabase import. Motherbase Realtime ignores it. */
  supabaseRealtime: boolean;
}

export interface PublicationOverview {
  publications: Publication[];
  walLevel: string;
}

export type PublicationUpdate = Partial<PublishActions> & { addTables?: TableRef[]; dropTables?: TableRef[] };

export type ConfigScope = 'database' | 'role' | 'system';

export interface PostgresSetting {
  name: string;
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
  pendingRestart: boolean;
  scopes: ConfigScope[];
  overrides: Array<{ scope: ConfigScope; role?: string; value: string }>;
}

export interface PostgresConfig {
  database: string;
  version: string;
  settings: PostgresSetting[];
  canAlterSystem: boolean;
  systemOverridesReadable: boolean;
  connection: {
    user: string;
    database: string;
    internalHost: string;
    internalPort: number;
    hostPort: number | null;
    bind: string;
    publiclyBound: boolean;
    pooler: null;
  };
}

export interface ConfigChange {
  name: string;
  value: string | null;
  scope?: ConfigScope;
  role?: string;
}

export interface ConfigChangeResult {
  applied: Array<{ name: string; scope: ConfigScope; role?: string }>;
  restartRequired: string[];
}

const data = <T>(response: { data: { data: T } }) => response.data.data;
const enumPath = (name: string) => `/admin/schema/enums/${encodeURIComponent(name)}`;

export const catalogApi = {
  tableStats: (schema: string) =>
    api.get('/admin/schema/table-stats', { params: { schema } }).then(r => data<{ tables: TableStats[] }>(r).tables),

  indexes: (schema: string) =>
    api.get('/admin/schema/indexes', { params: { schema } }).then(r => data<{ indexes: SchemaIndex[] }>(r).indexes),
  createIndex: (schema: string, table: string, body: { columns: string[]; unique: boolean; method: IndexMethod; name?: string }) =>
    api.post(`/admin/schema/tables/${encodeURIComponent(table)}/indexes`, body, { params: { schema } }),
  dropIndex: (schema: string, name: string) =>
    api.delete(`/admin/schema/indexes/${encodeURIComponent(name)}`, { params: { schema } }),

  enums: (schema: string) =>
    api.get('/admin/schema/enums', { params: { schema } }).then(r => data<{ enums: EnumType[] }>(r).enums),
  createEnum: (schema: string, name: string, values: string[]) =>
    api.post('/admin/schema/enums', { name, values }, { params: { schema } }),
  alterEnum: (schema: string, name: string, change: EnumChange) =>
    api.patch(enumPath(name), change, { params: { schema } }),
  dropEnum: (schema: string, name: string) => api.delete(enumPath(name), { params: { schema } }),

  roles: () => api.get('/admin/database/roles').then(r => data<{ roles: DatabaseRole[] }>(r).roles),
  createRole: (body: RoleWrite & { name: string }) => api.post('/admin/database/roles', body),
  updateRole: (name: string, body: RoleWrite) => api.patch(`/admin/database/roles/${encodeURIComponent(name)}`, body),
  dropRole: (name: string) => api.delete(`/admin/database/roles/${encodeURIComponent(name)}`),

  columnPrivileges: (schema: string, table: string) =>
    api.get('/admin/database/column-privileges', { params: { schema, table } }).then(r => data<ColumnPrivilegeMatrix>(r)),
  setColumnPrivilege: (change: ColumnPrivilegeChange) =>
    api.put('/admin/database/column-privileges', change).then(r => data<ColumnPrivilegeMatrix>(r)),

  publications: () => api.get('/admin/database/publications').then(r => data<PublicationOverview>(r)),
  createPublication: (body: PublishActions & { name: string; allTables?: boolean; tables?: TableRef[] }) =>
    api.post('/admin/database/publications', body),
  updatePublication: (name: string, body: PublicationUpdate) =>
    api.patch(`/admin/database/publications/${encodeURIComponent(name)}`, body),
  dropPublication: (name: string) => api.delete(`/admin/database/publications/${encodeURIComponent(name)}`),

  config: () => api.get('/admin/database/config').then(r => data<PostgresConfig>(r)),
  updateConfig: (changes: ConfigChange[]) =>
    api.patch('/admin/database/config', { changes }).then(r => data<ConfigChangeResult>(r)),
};
