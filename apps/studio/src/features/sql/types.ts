import type { DataRow } from '@/shared/types/data';

export interface SqlResult {
  kind: 'read' | 'write' | 'empty';
  columns?: string[];
  rows?: DataRow[];
  rowsAffected?: number;
  newRoutes?: Array<{ table: string }>;
  /** Some statement of the batch wrote, even when the last one read. */
  wrote?: boolean;
}

export interface SqlTab {
  id: string;
  title: string;
  sql: string;
  /** The saved snippet this tab was opened from or saved as, so Save updates it. */
  snippetId?: string;
  result?: SqlResult;
  error?: string;
  durationMs?: number;
}

/** A built-in starting query. Unlike a snippet it is not stored, nor editable. */
export interface SqlTemplate {
  id: string;
  title: string;
  sql: string;
}

export interface SqlHistoryEntry {
  id: string;
  sql: string;
  at: number;
  durationMs?: number;
  rows?: number;
}
