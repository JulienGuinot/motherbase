import { useEffect, useState, type ReactNode } from 'react';
import { PreferencesCtx, type ResolvedTheme } from '@/shared/lib/theme';
import {
  clearConsolePreferences,
  DEFAULT_PREFERENCES,
  readConsolePreferences,
  writeConsolePreferences,
  type AnimationPreference,
  type DensityPreference,
  type ThemePreference,
} from '@/shared/lib/preferences';

const DARK_SCHEME = '(prefers-color-scheme: dark)';

/**
 * The browser chrome, and the title or status bar of the installed app, take
 * their colour from theme-color. The console's own theme toggle can disagree
 * with the OS, so the tag follows the canvas actually painted.
 */
export function syncThemeColor(color: string): void {
  if (!color) return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  meta.content = color;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(() => readConsolePreferences(localStorage));
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    window.matchMedia(DARK_SCHEME).matches ? 'dark' : 'light',
  );
  const resolvedTheme = preferences.theme === 'system' ? systemTheme : preferences.theme;

  useEffect(() => {
    const media = window.matchMedia(DARK_SCHEME);
    const updateSystemTheme = (event: MediaQueryListEvent) => setSystemTheme(event.matches ? 'dark' : 'light');
    media.addEventListener('change', updateSystemTheme);
    return () => media.removeEventListener('change', updateSystemTheme);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.dataset.themePreference = preferences.theme;
    root.dataset.density = preferences.density;
    root.dataset.animations = preferences.animations;
    root.style.colorScheme = resolvedTheme;
    syncThemeColor(getComputedStyle(root).getPropertyValue('--bg').trim());
    writeConsolePreferences(localStorage, preferences);
  }, [preferences, resolvedTheme]);

  const patch = (next: Partial<typeof preferences>) => setPreferences(current => ({ ...current, ...next }));
  const setTheme = (theme: ThemePreference) => patch({ theme });
  const setDensity = (density: DensityPreference) => patch({ density });
  const setAnimations = (animations: AnimationPreference) => patch({ animations });
  const resetPreferences = () => {
    clearConsolePreferences(localStorage, sessionStorage);
    setPreferences(DEFAULT_PREFERENCES);
  };

  return (
    <PreferencesCtx.Provider value={{
      ...preferences,
      resolvedTheme,
      setTheme,
      setDensity,
      setAnimations,
      toggle: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
      resetPreferences,
    }}>
      {children}
    </PreferencesCtx.Provider>
  );
}
