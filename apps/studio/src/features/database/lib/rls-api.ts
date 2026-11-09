import { api } from '@/shared/lib/api';
import type { BuiltPolicy } from '@/features/database/lib/rls-templates';

export interface PgPolicy {
  name: string;
  command: string;
  roles: string[];
  using: string | null;
  withCheck: string | null;
  /** False for AS RESTRICTIVE: such a policy can only narrow what the permissive ones allow. */
  permissive: boolean;
}
export interface RlsTable {
  table: string;
  rlsEnabled: boolean;
  policies: PgPolicy[];
}

async function listTables(): Promise<RlsTable[]> {
  return (await api.get('/admin/rls/tables')).data.data;
}

/** What anon and authenticated can do to each table. Mirrors `services/admin/rls-access.ts`. */
export type AccessRole = 'anon' | 'authenticated';
export type AccessCommand = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface AccessCondition {
  policy: string;
  command: AccessCommand;
  restrictive: boolean;
  using: string | null;
  withCheck: string | null;
}

export type Access =
  | { level: 'all' }
  | { level: 'some'; conditions: AccessCondition[] }
  | { level: 'none'; blockedBy: 'grant' | 'policy' | 'read' };

export interface TableAccess {
  table: string;
  rlsEnabled: boolean;
  access: Record<AccessRole, Record<AccessCommand, Access>>;
}

async function accessMatrix(): Promise<TableAccess[]> {
  return (await api.get('/admin/rls/access')).data.data;
}

async function createPolicy(input: BuiltPolicy & { table: string; name: string }): Promise<void> {
  await api.post('/admin/rls/policies', input);
}

async function replacePolicy(
  prevName: string,
  input: BuiltPolicy & { table: string; name: string }
): Promise<void> {
  await api.put('/admin/rls/policies', { prevName, ...input });
}

async function dropPolicy(table: string, name: string): Promise<void> {
  await api.delete('/admin/rls/policies', { data: { table, name } });
}

async function toggleRls(table: string, enabled: boolean): Promise<void> {
  await api.post(`/admin/rls/tables/${table}/rls`, { enabled });
}

async function runSql(sql: string): Promise<void> {
  await api.post('/admin/sql', { sql });
}

export const rlsApi = {
  listTables,
  accessMatrix,
  createPolicy,
  replacePolicy,
  dropPolicy,
  toggleRls,
  runSql,
};
