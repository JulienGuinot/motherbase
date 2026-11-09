'use client';

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { apiToolsApi } from '@/features/api-tools/api/api-tools.api';
import { useRestResources, useRlsTables } from '@/features/api-tools/hooks/useApiTools';
import { buildEndpoints, endpointGroups, restTableFromPath, type Endpoint } from '@/features/api-tools/lib/endpoints';
import type { RlsTable } from '@/features/database/lib/rls-api';

/**
 * Catalogue, selection and request state for the API explorer workbench.
 *
 * The catalogue no longer depends on the schema picker: REST serves `public`
 * base tables and nothing else, so scoping this list by the selected schema
 * documented endpoints that answer 404.
 */
export function useApiExplorer() {
  const [group, setGroup] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<Endpoint | null>(null);
  const [path, setPath] = useState('');
  const [body, setBody] = useState('');

  const resourcesQuery = useRestResources();
  const rlsTablesQuery = useRlsTables();

  const endpoints = useMemo(() => buildEndpoints(resourcesQuery.data), [resourcesQuery.data]);
  const groups = useMemo(() => endpointGroups(endpoints), [endpoints]);
  const groupEndpoints = useMemo(
    () => (group ? endpoints.filter(e => e.group === group) : []),
    [endpoints, group]
  );

  const send = useMutation({
    mutationFn: async () => {
      if (!endpoint) throw new Error('No route selected');
      const url = path.startsWith('/') ? path : `/${path}`;
      const config: { url: string; method: string; data?: unknown } = { url, method: endpoint.method };
      if (['POST', 'PATCH'].includes(endpoint.method) && body.trim()) {
        try {
          config.data = JSON.parse(body);
        } catch {
          throw new Error('Body must be valid JSON.');
        }
      }
      const response = await apiToolsApi.request(config);
      return { status: response.status, data: response.data };
    },
  });

  const table = endpoint ? restTableFromPath(endpoint.path) : null;
  const rlsTable: RlsTable | undefined = table ? rlsTablesQuery.data?.find(t => t.table === table) : undefined;

  return {
    endpoints,
    groups,
    group,
    groupEndpoints,
    selectGroup: (next: string) => {
      setGroup(next);
      setEndpoint(null);
      setPath('');
      setBody('');
      send.reset();
    },
    endpoint,
    selectEndpoint: (next: Endpoint) => {
      setEndpoint(next);
      setPath(next.path);
      setBody(next.sampleBody ?? '');
      send.reset();
    },
    path,
    setPath,
    body,
    setBody,
    rlsTable,
    loadingTables: resourcesQuery.isLoading,
    resourcesQuery,
    send: () => send.mutate(),
    sending: send.isPending,
    status: send.data?.status,
    failed: send.isError,
    /** The error text on failure, otherwise the decoded response body. */
    response: send.isError ? getErrorMessage(send.error) : send.data?.data,
  };
}
