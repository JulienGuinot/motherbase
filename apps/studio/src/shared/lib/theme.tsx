import { createContext, useContext } from 'react';
import type {
  AnimationPreference,
  ConsolePreferences,
  DensityPreference,
  ThemePreference,
} from '@/shared/lib/preferences';

export type ResolvedTheme = 'dark' | 'light';

export interface PreferencesContextValue extends ConsolePreferences {
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePreference) => void;
  setDensity: (density: DensityPreference) => void;
  setAnimations: (animations: AnimationPreference) => void;
  toggle: () => void;
  resetPreferences: () => void;
}

export const PreferencesCtx = createContext<PreferencesContextValue | null>(null);

export function usePreferences(): PreferencesContextValue {
  const context = useContext(PreferencesCtx);
  if (!context) throw new Error('usePreferences must be used within ThemeProvider');
  return context;
}

export function useShikiTheme() {
  const { resolvedTheme } = usePreferences();
  return resolvedTheme === 'dark' ? 'github-dark' : 'github-light';
}
