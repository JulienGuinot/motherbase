// Builds CodeMirror SQL autocompletion config from the live database schema.
// Turns the `useSchemaTables` payload into an `SQLNamespace` so the editor can
// complete table names, and (once a table is in scope (FROM / JOIN / alias)) 
// its columns, with the Postgres type shown as the completion detail. Mirrors
// the Supabase SQL editor experience (schema-aware table + column suggestions).

import { PostgreSQL, type SQLConfig, type SQLNamespace } from '@codemirror/lang-sql';
import type { Completion } from '@codemirror/autocomplete';
import type { SchemaTable } from '@/shared/types/schema';

// Postgres / Supabase helper functions people reach for constantly. Surfaced as
// top-level completions so `gen_random_…`, `auth.uid…`, `now…` all resolve.
const HELPER_FUNCTIONS: Completion[] = [
  { label: 'gen_random_uuid()', type: 'function', detail: 'uuid', info: 'Random UUID v4 (pgcrypto / PG13+).' },
  { label: 'now()', type: 'function', detail: 'timestamptz', info: 'Current transaction timestamp.' },
  { label: 'auth.uid()', type: 'function', detail: 'uuid', info: 'ID of the authenticated user (RLS).' },
  { label: 'auth.role()', type: 'function', detail: 'text', info: 'Role of the current request (RLS).' },
  { label: 'auth.jwt()', type: 'function', detail: 'jsonb', info: 'Decoded JWT claims of the request.' },
  { label: 'count(*)', type: 'function', detail: 'bigint' },
  { label: 'coalesce()', type: 'function', detail: 'any' },
  { label: 'date_trunc()', type: 'function', detail: 'timestamp' },
  { label: 'jsonb_build_object()', type: 'function', detail: 'jsonb' },
  { label: 'string_agg()', type: 'function', detail: 'text' },
];

/** One completion entry per column, carrying its Postgres type as detail. */
function columnCompletion(col: SchemaTable['columns'][number]): Completion {
  return {
    label: col.name,
    type: 'property',
    detail: col.isPrimaryKey ? `${col.type} · PK` : col.type,
    // Primary keys and common lookup columns surface first.
    boost: col.isPrimaryKey ? 2 : col.name === 'id' ? 1 : 0,
  };
}

/**
 * Convert the schema payload into an `SQLNamespace`. Each table maps to a
 * `{ self, children }` node so the table itself completes as a table icon and
 * its columns complete once the table is referenced.
 */
function buildSqlNamespace(tables: SchemaTable[] | undefined): SQLNamespace {
  const ns: Record<string, SQLNamespace> = {};
  for (const table of tables ?? []) {
    ns[table.name] = {
      self: { label: table.name, type: 'type', detail: `table · ${table.columns.length} cols` },
      children: table.columns.map(columnCompletion),
    };
  }
  return ns;
}

/** Full SQLConfig for `sql()`: Postgres dialect, schema-aware, upper-case keywords. */
export function buildSqlConfig(tables: SchemaTable[] | undefined): SQLConfig {
  return {
    dialect: PostgreSQL,
    upperCaseKeywords: true,
    schema: buildSqlNamespace(tables),
    tables: HELPER_FUNCTIONS,
  };
}
