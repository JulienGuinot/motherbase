export const ROW_EVENT_ACTIONS = ['created', 'updated', 'deleted'] as const;

// Kept in sync with apps/server/services/events/event-dispatcher.service.ts.
export const AUTH_EVENT_ACTIONS = [
  'sign-in',
  'sign-up',
  'sign-out',
  'forget-password',
  'reset-password',
  'verify-email',
  'two-factor',
] as const;

export const AUTH_EVENT_MODEL = 'auth';

export interface EventTableMeta {
  model: string;
  dbName?: string;
  /** Postgres schema the table lives in, as reported by `GET /admin/tables`. */
  schema?: string;
}

// Row events only ever fire for application tables: everything Motherbase owns
// lives in the `auth`, `storage` or `platform` schemas, and only `public` is
// exposed over /rest/v1 where mutations are dispatched from. Keying on the
// schema is the same rule the server enforces, so it cannot drift from it the
// way a hand-written model list would.
const APP_SCHEMA = 'public';

export function isUserEventTable(table: EventTableMeta): boolean {
  if (/^(_prisma_|pg_)/i.test(table.dbName ?? table.model)) return false;
  // Absent schema means an API older than the field; treat it as an app table
  // rather than hiding a legitimate one from the picker.
  return (table.schema ?? APP_SCHEMA) === APP_SCHEMA;
}

export function eventModelName(model: string): string {
  return model.toLowerCase();
}

export function formatEventSpec(spec: string, tables: EventTableMeta[]): string {
  if (spec === '*') return 'All tables / all operations';

  const [model, action] = spec.split('.');
  if (model === AUTH_EVENT_MODEL) return `Auth / ${action}`;

  const tableName = model === '*'
    ? 'All tables'
    : tables.find(table => eventModelName(table.model) === model)?.model ?? model;
  const actionName = action === '*' ? 'all operations' : action;

  return `${tableName} / ${actionName}`;
}
