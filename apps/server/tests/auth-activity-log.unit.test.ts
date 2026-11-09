import { describe, it, expect, vi } from 'vitest';
import type { LogEntry } from '../lib/log-buffer';

// Same stand-in buffer as activity-log.unit.test.ts: models/ pulls in Prisma and
// this is a pure unit test of which auth paths reach the Logs stream.
const { entries } = vi.hoisted(() => ({ entries: [] as Array<Omit<LogEntry, 'id' | 'at'>> }));

vi.mock('../models', () => ({
  logBuffer: {
    push: (entry: Omit<LogEntry, 'id' | 'at'>) => {
      entries.push(entry);
      return entry;
    },
  },
}));

import { logAuthActivity } from '../auth/auth-activity';

describe('logAuthActivity', () => {
  it('logs a meaningful endpoint with the user', () => {
    logAuthActivity('/sign-in/email', 'usr_1');
    expect(entries.at(-1)).toEqual({ level: 'info', source: 'auth', message: '[auth] sign-in/email user=usr_1' });
  });

  it('logs a rejection as a warning, with the reason', () => {
    logAuthActivity('/sign-in/email', null, 'INVALID_PASSWORD');
    expect(entries.at(-1)).toEqual({
      level: 'warn',
      source: 'auth',
      message: '[auth] sign-in/email rejected: INVALID_PASSWORD',
    });
  });

  it('skips the paths every authenticated page hit triggers', () => {
    const before = entries.length;
    for (const path of ['/get-session', '/jwks', '/token', '/ok', '/error', '/list-sessions', '/token/refresh']) {
      logAuthActivity(path, 'usr_1');
    }
    expect(entries.length).toBe(before);
  });
});
