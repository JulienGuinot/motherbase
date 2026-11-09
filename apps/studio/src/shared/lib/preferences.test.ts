import { describe, expect, it } from 'vitest';
import {
  clearConsolePreferences,
  CONSOLE_PREFERENCE_KEYS,
  DEFAULT_PREFERENCES,
  readConsolePreferences,
  writeConsolePreferences,
} from '@/shared/lib/preferences';

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe('console preferences', () => {
  it('uses defaults for missing or invalid values', () => {
    const storage = new MemoryStorage();
    storage.setItem('console.theme', 'invalid');

    expect(readConsolePreferences(storage)).toEqual(DEFAULT_PREFERENCES);
  });

  it('round-trips appearance preferences', () => {
    const storage = new MemoryStorage();
    const preferences = { theme: 'dark', density: 'compact', animations: 'off' } as const;

    writeConsolePreferences(storage, preferences);

    expect(readConsolePreferences(storage)).toEqual(preferences);
  });

  it('clears known preferences without removing authentication', () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    CONSOLE_PREFERENCE_KEYS.forEach(key => local.setItem(key, 'value'));
    local.setItem('console.accessToken', 'token');
    session.setItem('console.mfaNudgeDismissed', '1');

    clearConsolePreferences(local, session);

    expect(CONSOLE_PREFERENCE_KEYS.every(key => local.getItem(key) === null)).toBe(true);
    expect(local.getItem('console.accessToken')).toBe('token');
    expect(session.getItem('console.mfaNudgeDismissed')).toBeNull();
  });
});
