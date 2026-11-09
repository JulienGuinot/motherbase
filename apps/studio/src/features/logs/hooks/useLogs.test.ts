import { describe, expect, it } from 'vitest';
import { flattenLogPages } from '@/features/logs/hooks/useLogs';
import type { LogEntry, LogPage } from '@/features/logs/types';

const page = (...ids: number[]): LogPage => ({
  logs: ids.map(id => ({ id }) as LogEntry),
  persisted: true,
  retentionDays: 30,
  oldestAvailable: null,
  hasMore: true,
  nextCursor: null,
});

describe('flattenLogPages', () => {
  it('keeps the stream oldest first when older pages are appended', () => {
    // Page 0 is the newest lines, each page oldest first, as the server sends them.
    expect(flattenLogPages([page(5, 6), page(3, 4), page(1, 2)]).map(entry => entry.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
