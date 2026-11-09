export type ThemePreference = 'light' | 'dark' | 'system';
export type DensityPreference = 'comfortable' | 'compact';
export type AnimationPreference = 'on' | 'off';

export interface ConsolePreferences {
  theme: ThemePreference;
  density: DensityPreference;
  animations: AnimationPreference;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFERENCE_KEYS = {
  theme: 'console.theme',
  density: 'console.density',
  animations: 'console.animations',
} as const;

export const DEFAULT_PREFERENCES: ConsolePreferences = {
  theme: 'system',
  density: 'comfortable',
  animations: 'on',
};

// Every browser-only console preference belongs here. Authentication tokens are
// intentionally excluded: resetting the interface must never sign the user out.
export const CONSOLE_PREFERENCE_KEYS = [
  ...Object.values(PREFERENCE_KEYS),
  'console.sidebar',
  'console.schema',
  'console.logViews',
  'console.sql.tabs',
  'console.sql.active',
  'console.sql.history',
  'console.sql.snippets',
  'console.onboarding.project.seen',
  'console.onboarding.fleet.seen',
  'console.activeOrg',
  'console.alerts.cpuThreshold',
  'console.alerts.memThreshold',
  'console.fleet.usageHistory',
] as const;

const CONSOLE_SESSION_PREFERENCE_KEYS = ['console.mfaNudgeDismissed'] as const;

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function readConsolePreferences(storage: StorageLike): ConsolePreferences {
  return {
    theme: oneOf(storage.getItem(PREFERENCE_KEYS.theme), ['light', 'dark', 'system'], DEFAULT_PREFERENCES.theme),
    density: oneOf(storage.getItem(PREFERENCE_KEYS.density), ['comfortable', 'compact'], DEFAULT_PREFERENCES.density),
    animations: oneOf(storage.getItem(PREFERENCE_KEYS.animations), ['on', 'off'], DEFAULT_PREFERENCES.animations),
  };
}

export function writeConsolePreferences(storage: StorageLike, preferences: ConsolePreferences): void {
  storage.setItem(PREFERENCE_KEYS.theme, preferences.theme);
  storage.setItem(PREFERENCE_KEYS.density, preferences.density);
  storage.setItem(PREFERENCE_KEYS.animations, preferences.animations);
}

export function clearConsolePreferences(local: StorageLike, session?: StorageLike): void {
  CONSOLE_PREFERENCE_KEYS.forEach(key => local.removeItem(key));
  CONSOLE_SESSION_PREFERENCE_KEYS.forEach(key => session?.removeItem(key));
}
