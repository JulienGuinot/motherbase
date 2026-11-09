'use client';

import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { invalidateFor, type InvalidationEvent } from '@/shared/lib/invalidate';
import { keepPreviousFor } from '@/shared/lib/query';
import { useToast } from '@/shared/lib/toast';
import { catalogApi } from '@/features/database/api/catalog.api';

// Reads for the Database section. Schema-scoped queries keep the previous
// result only while the same schema reloads, never across a schema change.

export function useTableStats(schema: string) {
  return useQuery({
    placeholderData: keepPreviousFor(schema),
    queryKey: ['db-table-stats', schema],
    queryFn: () => catalogApi.tableStats(schema),
  });
}

export function useSchemaIndexes(schema: string) {
  return useQuery({
    placeholderData: keepPreviousFor(schema),
    queryKey: ['db-indexes', schema],
    queryFn: () => catalogApi.indexes(schema),
  });
}

export function useEnumTypes(schema: string) {
  return useQuery({
    placeholderData: keepPreviousFor(schema),
    queryKey: ['db-enums', schema],
    queryFn: () => catalogApi.enums(schema),
  });
}

export function useDatabaseRoles() {
  return useQuery({ queryKey: ['db-roles'], queryFn: catalogApi.roles });
}

export function useColumnPrivileges(schema: string, table: string | undefined) {
  return useQuery({
    queryKey: ['db-column-privileges', schema, table],
    queryFn: () => catalogApi.columnPrivileges(schema, table!),
    enabled: Boolean(table),
  });
}

export function usePublications() {
  return useQuery({ queryKey: ['db-publications'], queryFn: catalogApi.publications });
}

export function usePostgresConfig() {
  return useQuery({ queryKey: ['db-config'], queryFn: catalogApi.config });
}

/**
 * The write shape every Database page repeats: run, toast, refetch what it
 * touched. Refetching rather than patching the cache is deliberate: these are
 * DDL statements whose effect (a renamed enum value, a split column grant) is
 * the server's to describe, not the page's to guess.
 */
export function useCatalogWrite<TVars, TResult = unknown>(options: {
  run: (variables: TVars) => Promise<TResult>;
  /**
   * What the write can make stale: `schema.changed` for DDL (every screen
   * describing the database's shape), or explicit keys for cluster-level state
   * such as roles and settings.
   */
  invalidate: InvalidationEvent | QueryKey[];
  success: string | ((variables: TVars, result: TResult) => string);
  failTitle: string;
  onSuccess?: (result: TResult, variables: TVars) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: options.run,
    onSuccess: (result, variables) => {
      const title = typeof options.success === 'function' ? options.success(variables, result) : options.success;
      toast.push({ kind: 'success', title });
      options.onSuccess?.(result, variables);
    },
    onError: error => toast.push({ kind: 'error', title: options.failTitle, message: getErrorMessage(error) }),
    onSettled: () => {
      if (typeof options.invalidate === 'string') void invalidateFor(qc, options.invalidate);
      else for (const queryKey of options.invalidate) void qc.invalidateQueries({ queryKey });
    },
  });
}
