import type { SqlTemplate, SqlTab } from '@/features/sql/types';

export const DEFAULT_SQL = 'SELECT * FROM users LIMIT 50;';

const TODO_STARTER_SQL = `CREATE TABLE todo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  user_id text DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE POLICY "todo public read" ON todo FOR SELECT TO anon USING (true);

CREATE POLICY "todo auth read" ON todo FOR SELECT TO authenticated USING (true);

CREATE POLICY "todo owner write" ON todo FOR ALL TO authenticated
  USING (auth.uid() IS NOT NULL AND auth.uid() = user_id)
  WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = user_id);`;

export const SQL_TEMPLATES: SqlTemplate[] = [
  { id: 's0', title: 'Create todo table + RLS', sql: TODO_STARTER_SQL },
  { id: 's1', title: 'Recent users', sql: 'SELECT id, email, role, "createdAt"\nFROM "users"\nORDER BY "createdAt" DESC\nLIMIT 25;' },
  { id: 's2', title: 'Daily signups (30d)', sql: "SELECT DATE_TRUNC('day', \"createdAt\") AS day, COUNT(*) AS signups\nFROM \"users\"\nWHERE \"createdAt\" > NOW() - INTERVAL '30 days'\nGROUP BY 1\nORDER BY 1 DESC;" },
  { id: 's3', title: 'Largest files', sql: 'SELECT "key", "size", "createdAt"\nFROM "files"\nORDER BY "size" DESC\nLIMIT 25;' },
  { id: 's4', title: 'Schema overview', sql: "SELECT table_name, column_name, data_type\nFROM information_schema.columns\nWHERE table_schema='public'\nORDER BY table_name, ordinal_position;" },
];

export const SQL_STORAGE_KEYS = {
  tabs: 'console.sql.tabs',
  active: 'console.sql.active',
  history: 'console.sql.history',
};

export const HISTORY_LIMIT = 50;

export const uid = (): string => Math.random().toString(36).slice(2, 9);

export const newTab = (index: number, sql = '-- New query\n'): SqlTab => ({
  id: uid(),
  title: `Query ${index}`,
  sql,
});

/**
 * A `?q=` parameter means another page (the table editor, a slow-query panel)
 * sent a query here. It opens as an extra tab and the parameter is then dropped
 * so a reload does not open it again.
 */
export function queryFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('q');
}

export function dropQueryParam(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('q');
  window.history.replaceState(window.history.state, '', url);
}
