import type { Tone } from '@/shared/ui/Badge';

// Every auth panel answers the same question: is this method turned on, and is
// it actually configured? Derive it once here instead of re-deriving the same
// ternary in each panel.
export type Readiness = 'ready' | 'warn' | 'off';

export function readinessOf(enabled: unknown, configured: boolean | undefined): Readiness {
  if (!enabled) return 'off';
  return configured ? 'ready' : 'warn';
}

export function readinessTone(state: Readiness): Tone {
  return state === 'ready' ? 'success' : state === 'warn' ? 'warn' : 'neutral';
}

export function readinessLabel(state: Readiness, missing?: string[]): string {
  if (state === 'ready') return 'Ready';
  if (state === 'warn') return missing?.length ? `Needs ${missing.join(', ')}` : 'Needs setup';
  return 'Off';
}
