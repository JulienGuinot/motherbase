import { useQuery } from '@tanstack/react-query';
import { platform } from '@/shared/lib/api';

export interface PlatformFeatures {
  /** Metered billing surfaces. Off unless the operator turned them on. */
  billing: boolean;
}

const DEFAULTS: PlatformFeatures = { billing: false };

/**
 * Optional console surfaces, read from `/platform/info`.
 *
 * Defaults are off and stay off while the request is in flight: a tab that
 * appears a second after load, or appears against an older console that does not
 * report the flag at all, is worse than one that never appears.
 */
export function usePlatformFeatures(): PlatformFeatures {
  return usePlatformFeatureState().features;
}

/**
 * Same data with the loading flag, for callers that must not act on the
 * defaults. A route guard is one: redirecting on the default would send the
 * operator away from a surface that is in fact enabled, before the answer
 * arrives. A nav entry is not: it can simply stay hidden until then.
 */
export function usePlatformFeatureState(): { features: PlatformFeatures; pending: boolean } {
  const query = useQuery({ queryKey: ['platform-info'], queryFn: platform.info, staleTime: 5 * 60_000 });
  return {
    features: { ...DEFAULTS, ...(query.data?.features ?? {}) },
    pending: query.isPending,
  };
}
