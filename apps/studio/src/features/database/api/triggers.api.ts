import { api } from '@/shared/lib/api';
import type { TriggerInfo } from '@/features/database/types';

/** Narrow shapes used only by the Triggers page dropdowns. */
export interface TriggerTableRef { name: string }
export interface TriggerFnRef { name: string; returnType: string }

export const triggersApi = {
  list: (schema: string) =>
    api.get(`/admin/schema/triggers?schema=${encodeURIComponent(schema)}`).then(r => r.data.data.triggers as TriggerInfo[]),
  tables: (schema: string) =>
    api.get(`/admin/schema/tables?schema=${encodeURIComponent(schema)}`).then(r => r.data.data.tables as TriggerTableRef[]),
  /**
   * Scoped, like every other list here. It used to ask for `public` whatever
   * schema was selected, so the form could say "create a trigger function
   * first" while looking past the ones defined in the selected schema.
   */
  triggerFunctions: (schema: string) =>
    api
      .get('/admin/schema/trigger-functions', { params: { schema } })
      .then(r => r.data.data.functions as TriggerFnRef[]),
  create: (sql: string) => api.post('/admin/schema/triggers', { sql }),
  /**
   * `schema` travels with every mutation.
   *
   * Reads passed it and writes did not, although the server has always accepted
   * it: a trigger read from a custom schema was dropped or toggled in `public`,
   * hitting a same-named trigger there or nothing at all.
   */
  drop: (name: string, table: string, schema: string) =>
    api.delete(`/admin/schema/triggers/${encodeURIComponent(name)}`, { params: { table, schema } }),
  setEnabled: (name: string, table: string, enabled: boolean, schema: string) =>
    api.post(`/admin/schema/triggers/${encodeURIComponent(name)}/enabled`, { table, enabled }, { params: { schema } }),
};
