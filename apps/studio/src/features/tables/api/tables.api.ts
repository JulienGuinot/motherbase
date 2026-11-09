import type { DataRow } from '@/shared/types/data';
import { api } from '@/shared/lib/api';
import type {
  IndexInfo,
  SchemaGraph,
  TableMeta,
} from '@/features/tables/components/table.types';
import type { SchemaTable } from '@/shared/types/schema';

export interface RowsPage {
  rows: DataRow[];
  total: number;
  /**
   * True when `total` came from the planner rather than an exact COUNT(*).
   * The server stops counting large unfiltered tables exactly, because that is
   * a full scan on the same database the app is running on.
   */
  estimated?: boolean;
  page: number;
  pageSize: number;
}

export interface ColumnForeignKey {
  table: string;
  column: string;
  onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
}

export interface AddColumnBody {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  unique?: boolean;
  isPrimaryKey?: boolean;
  check?: string | null;
  comment?: string | null;
  references?: ColumnForeignKey | null;
}

export const tablesApi = {
  tables: () => api.get('/admin/tables').then(r => r.data.data.tables as TableMeta[]),
  /**
   * `model` may be a qualified `schema.table` id for a table outside `public`,
   * so it is encoded rather than interpolated raw.
   */
  rows: (model: string, params: URLSearchParams) =>
    api
      .get(`/admin/tables/${encodeURIComponent(model)}/rows?${params.toString()}`)
      .then(r => r.data.data as RowsPage),
  schemaTables: (schema: string) =>
    api.get(`/admin/schema/tables?schema=${encodeURIComponent(schema)}`).then(r => r.data.data.tables as SchemaTable[]),
  indexes: (dbName: string, schema: string) =>
    api.get(`/admin/schema/tables/${dbName}/indexes?schema=${encodeURIComponent(schema)}`).then(r => r.data.data.indexes as IndexInfo[]),
  graph: (schema: string) =>
    api.get(`/admin/schema/graph?schema=${encodeURIComponent(schema)}`).then(r => r.data.data as SchemaGraph),

  createRow: (model: string, data: Record<string, unknown>) =>
    api.post(`/admin/tables/${encodeURIComponent(model)}/rows`, data),
  updateRow: (model: string, id: string | number, data: Record<string, unknown>) =>
    api.patch(`/admin/tables/${encodeURIComponent(model)}/rows/${encodeURIComponent(String(id))}`, data),
  deleteRow: (model: string, id: string | number) =>
    api.delete(`/admin/tables/${encodeURIComponent(model)}/rows/${encodeURIComponent(String(id))}`),
  createTable: (sql: string, policyPreset: string) =>
    api
      .post('/admin/schema/tables', { sql, policyPreset })
      .then(r => r.data.data as { newRoutes?: unknown[]; notRestExposed?: string[] }),
  addColumn: (tableName: string, schema: string, body: AddColumnBody) =>
    api.post(`/admin/schema/tables/${tableName}/columns?schema=${encodeURIComponent(schema)}`, body),
  renameColumn: (tableName: string, column: string, schema: string, name: string) =>
    api.patch(`/admin/schema/tables/${tableName}/columns/${column}/rename?schema=${encodeURIComponent(schema)}`, { name }),
  setColumnNullable: (tableName: string, column: string, schema: string, nullable: boolean) =>
    api.patch(`/admin/schema/tables/${tableName}/columns/${column}/nullable?schema=${encodeURIComponent(schema)}`, { nullable }),
  setColumnDefault: (tableName: string, column: string, schema: string, value: string | null) =>
    api.patch(`/admin/schema/tables/${tableName}/columns/${column}/default?schema=${encodeURIComponent(schema)}`, { value }),
  createIndex: (
    tableName: string,
    schema: string,
    body: { columns: string[]; unique: boolean; method: string },
  ) =>
    api.post(`/admin/schema/tables/${tableName}/indexes?schema=${encodeURIComponent(schema)}`, body),
  dropColumn: (dbName: string, column: string, schema: string) =>
    api.delete(`/admin/schema/tables/${dbName}/columns/${column}?schema=${encodeURIComponent(schema)}`),
  dropIndex: (name: string, schema: string) =>
    api.delete(`/admin/schema/indexes/${name}?schema=${encodeURIComponent(schema)}`),
  dropTable: (dbName: string, schema: string) =>
    api.delete(`/admin/schema/tables/${dbName}?schema=${encodeURIComponent(schema)}`),
};
