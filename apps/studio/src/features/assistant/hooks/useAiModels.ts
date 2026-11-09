'use client';

import { useQuery } from '@tanstack/react-query';
import { listModels, type AiCatalogue, type AiConfigOverride } from '@/features/assistant/api/assistant.api';

// The key itself is part of the cache key: pasting one must re-list, and two
// different keys for the same provider are two different catalogues. It never
// leaves the browser's memory, which already holds the form field it came from.
export const aiModelsKey = (over: AiConfigOverride = {}) =>
  ['ai-models', over.provider ?? '', over.baseUrl ?? '', over.apiKey ?? ''] as const;

/**
 * The provider's model catalogue, shared by the settings picker and the dock's
 * per-conversation switcher.
 *
 * Cached for five minutes: a vendor's model list changes on the order of
 * weeks, and the request costs a round trip to the provider.
 *
 * `over` describes what the operator has on screen in the settings form, which
 * may not be what is saved yet; an empty override asks about the saved
 * configuration.
 */
export function useAiModels(over: AiConfigOverride = {}, enabled = true) {
  return useQuery<AiCatalogue>({
    queryKey: aiModelsKey(over),
    queryFn: () => listModels(over),
    staleTime: 5 * 60_000,
    // The dock is mounted on every page but usually collapsed; discovery hits
    // the provider, so it must not run until someone opens it.
    enabled,
  });
}
