import { isNumeric } from '@/shared/ui/RowDrawer';

/**
 * Coerce the typed string back to something the column will accept. Empty means
 * NULL, which is the only way to clear a value from the grid; numbers that do
 * not parse are sent as-is so the API's own validation reports the problem
 * rather than the grid silently writing NaN.
 */
export function parseCell(draft: string, type: string): unknown {
  if (draft === '') return null;
  if (type === 'Boolean') return draft.toLowerCase() === 'true';
  if (isNumeric(type)) {
    const n = Number(draft);
    return Number.isNaN(n) ? draft : n;
  }
  return draft;
}
