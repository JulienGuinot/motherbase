import { api } from '@/shared/lib/api';
import type { FnInfo } from '@/features/database/types';

export const functionsApi = {
  list: (schema: string) =>
    api.get(`/admin/schema/functions?schema=${encodeURIComponent(schema)}`).then(r => r.data.data.functions as FnInfo[]),
  save: (sql: string) => api.post('/admin/schema/functions', { sql }),
  // By signature, not by name: `name()` addressed the wrong overload, or none.
  drop: (fn: FnInfo) => api.delete(`/admin/schema/functions/${encodeURIComponent(fn.signature)}`),
};
