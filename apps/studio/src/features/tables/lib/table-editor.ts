import { SYSTEM_SCHEMAS } from '@/shared/lib/schema';
import type { TabId } from '@/features/tables/components/table.types';

export { SYSTEM_SCHEMAS };
export type { RowFilter } from '@/features/tables/lib/filters';
export type { TabId };

export const TABS: TabId[] = ['data', 'schema', 'indexes', 'graph', 'policies'];

export const isTab = (value: string | null): value is TabId =>
  Boolean(value && TABS.includes(value as TabId));

/** Primary-key values reach the API as a path segment, so they must be scalar. */
export const rowId = (value: unknown): string | number =>
  typeof value === 'string' || typeof value === 'number' ? value : String(value ?? '');

/**
 * A cached page of rows with the given primary keys taken out, and `total`
 * reduced by however many this page actually held.
 *
 * Returns the page unchanged when it holds none of them, so React Query's cache
 * identity is preserved and pages that were not affected do not re-render.
 */
export function removeRowsFromPage<T extends { rows: Record<string, unknown>[]; total: number }>(
  page: T,
  ids: Set<string>,
  primaryKey: string,
): T {
  const kept = page.rows.filter(row => !ids.has(String(row[primaryKey])));
  if (kept.length === page.rows.length) return page;
  return { ...page, rows: kept, total: Math.max(0, page.total - (page.rows.length - kept.length)) };
}

/**
 * A cached page with one cell of one row replaced. Like `removeRowsFromPage`,
 * returns the page unchanged when the row is not on it.
 */
export function patchCellInPage<T extends { rows: Record<string, unknown>[] }>(
  page: T,
  id: string,
  primaryKey: string,
  column: string,
  value: unknown,
): T {
  if (!page.rows.some(row => String(row[primaryKey]) === id)) return page;
  return {
    ...page,
    rows: page.rows.map(row => (String(row[primaryKey]) === id ? { ...row, [column]: value } : row)),
  };
}

export const rowsLabel = (count: number) => `${count} row${count === 1 ? '' : 's'}`;

export const selectAllSql = (dbName: string) => `SELECT * FROM "${dbName}" LIMIT 50;`;
