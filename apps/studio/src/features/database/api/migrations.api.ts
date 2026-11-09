import { api } from '@/shared/lib/api';
import type { Draft, DiffResult, MigrationDetail, MigrationRow } from '@/features/database/types';

export const migrationsApi = {
  // The controller wraps both of these ({ migrations }, { migration }), like
  // every other list route on it. Reading r.data.data straight handed the list
  // an object, and MigrationList crashed on .map.
  list: () => api.get('/admin/migrations').then(r => r.data.data.migrations as MigrationRow[]),
  detail: (id: string) =>
    api.get(`/admin/migrations/${id}`).then(r => r.data.data.migration as MigrationDetail),
  diff: () => api.get('/admin/migrations/diff').then(r => r.data.data as DiffResult),
  create: (d: Draft) =>
    api.post('/admin/migrations', {
      name: d.name.trim(),
      upSql: d.upSql,
      downSql: d.downSql.trim() ? d.downSql : undefined,
    }),
  apply: (id: string) => api.post(`/admin/migrations/${id}/apply`),
  rollback: (id: string) => api.post(`/admin/migrations/${id}/rollback`),
  /** `migration repair`: rewrite the history for a version, running no SQL. */
  repair: (version: string, status: 'applied' | 'reverted') =>
    api.post(`/admin/db/migrations/${encodeURIComponent(version)}/repair`, { status }),
};
