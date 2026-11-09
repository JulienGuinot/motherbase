import { describe, it, expect, vi } from 'vitest';
import type { LogEntry } from '../lib/log-buffer';

// The helper writes to the shared buffer in models/, which pulls in Prisma.
// A stand-in buffer keeps this a pure unit test of the helper's own contract.
const { entries, state } = vi.hoisted(() => ({
  entries: [] as Array<Omit<LogEntry, 'id' | 'at'>>,
  state: { fail: false },
}));

vi.mock('../models', () => ({
  logBuffer: {
    push: (entry: Omit<LogEntry, 'id' | 'at'>) => {
      if (state.fail) throw new Error('buffer is gone');
      entries.push(entry);
      return entry;
    },
  },
}));

import { logActivity } from '../lib/activity-log';

describe('logActivity', () => {
  it('writes level, source and message to the shared buffer', () => {
    logActivity('error', 'edge', '[edge:sync] failed');
    expect(entries.at(-1)).toEqual({ level: 'error', source: 'edge', message: '[edge:sync] failed' });
  });

  it('truncates oversized messages so one line cannot flood the buffer', () => {
    logActivity('info', 'job', 'x'.repeat(5_000));
    const message = entries.at(-1)!.message;
    expect(message.length).toBeLessThanOrEqual(2_001);
    expect(message.endsWith('…')).toBe(true);
  });

  it('never throws when the buffer fails', () => {
    state.fail = true;
    expect(() => logActivity('warn', 'shield', 'rate limit')).not.toThrow();
    state.fail = false;
  });
});
