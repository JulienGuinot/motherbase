import { api } from '@/shared/lib/api';

// Shapes of `/admin/wrappers*`, see apps/server/services/admin/wrapper.service.ts.

export type WrapperName = 'postgres_fdw' | 'file_fdw';

export interface WrapperInfo {
  name: WrapperName;
  available: boolean;
  installed: boolean;
}

export interface ForeignServer {
  name: string;
  wrapper: string;
  options: Record<string, string>;
  hasUserMapping: boolean;
  remoteUser: string | null;
  /** The Vault secret holding the password (`fdw_<server>`), when one was stored. */
  vaultSecretId: string | null;
  foreignTables: number;
}

export interface ForeignTable {
  schema: string;
  name: string;
  server: string;
  options: Record<string, string>;
  columns: number;
}

export interface WrappersState {
  wrappers: WrapperInfo[];
  servers: ForeignServer[];
  tables: ForeignTable[];
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

const server = (name: string) => `/admin/wrappers/servers/${encodeURIComponent(name)}`;

export const wrappersApi = {
  list: () => api.get('/admin/wrappers').then(r => r.data.data as WrappersState),
  enable: (wrapper: WrapperName) => api.post(`/admin/wrappers/${wrapper}/enable`),
  createServer: (input: CreateServerInput) =>
    api.post('/admin/wrappers/servers', input).then(r => r.data.data.server as ForeignServer),
  setCredentials: (name: string, credentials: { user: string; password: string }) =>
    api.put(`${server(name)}/credentials`, credentials).then(r => r.data.data.server as ForeignServer),
  importSchema: (name: string, input: ImportSchemaInput) =>
    api.post(`${server(name)}/import`, input).then(r => r.data.data.tables as ForeignTable[]),
  dropServer: (name: string) => api.delete(server(name)),
  createTable: (input: CreateForeignTableInput) =>
    api.post('/admin/wrappers/tables', input).then(r => r.data.data.table as ForeignTable),
  dropTable: (schema: string, name: string) =>
    api.delete(`/admin/wrappers/tables/${encodeURIComponent(schema)}/${encodeURIComponent(name)}`),
};
