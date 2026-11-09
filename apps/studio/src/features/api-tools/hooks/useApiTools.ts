import { useQuery } from '@tanstack/react-query';
import { keepPreviousFor } from '@/shared/lib/query';
import { apiToolsApi } from '@/features/api-tools/api/api-tools.api';
import { rlsApi } from '@/features/database/lib/rls-api';

export function useRlsTables() {
  return useQuery({
    queryKey: ['rls-tables'],
    queryFn: () => rlsApi.listTables(),
    staleTime: 15_000,
  });
}

/** The REST-exposed resource catalogue. Not schema-scoped: REST serves `public`. */
export function useRestResources() {
  return useQuery({
    queryKey: ['rest-resources'],
    queryFn: apiToolsApi.restResources,
    staleTime: 30_000,
  });
}

export function useEdgeFunctions() {
  return useQuery({
    queryKey: ['edge-functions'],
    queryFn: apiToolsApi.edgeFunctions,
  });
}

export function useEdgeFunctionLogs(id: string | undefined, enabled: boolean) {
  return useQuery({
    // Keep the previous result on screen while the new selection loads.
    placeholderData: keepPreviousFor(id),
    queryKey: ['edge-function-logs', id],
    enabled: Boolean(id) && enabled,
    queryFn: () => apiToolsApi.edgeFunctionLogs(id!),
    refetchInterval: 5000,
  });
}

export function useEdgeSecrets(enabled: boolean) {
  return useQuery({
    queryKey: ['edge-secrets'],
    enabled,
    queryFn: apiToolsApi.secrets,
  });
}
