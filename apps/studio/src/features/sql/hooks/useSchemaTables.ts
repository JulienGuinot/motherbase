import { useQuery } from '@tanstack/react-query';
import { sqlApi } from '@/features/sql/api/sql.api';

export function useSchemaTables(schema?: string) {
  return useQuery({
    queryKey: ['schema-tables', schema ?? 'public'],
    queryFn: () => sqlApi.schemaTables(schema),
    staleTime: 30_000,
  });
}
