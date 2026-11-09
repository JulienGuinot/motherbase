import { api } from '@/shared/lib/api';
import type { SqlResult } from '@/features/sql/types';
import type { SchemaTable } from '@/shared/types/schema';

export const sqlApi = {
  schemaTables: (schema?: string) =>
    api
      .get('/admin/schema/tables', { params: schema ? { schema } : undefined })
      .then(r => r.data.data.tables as SchemaTable[]),
  run: (sql: string) =>
    api.post('/admin/sql', { sql }).then(r => r.data.data as SqlResult),
};
