'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/shared/lib/api';

async function fetchSchemas(): Promise<string[]> {
  const { data } = await api.get('/admin/schema/schemas');
  return data.data.schemas;
}

/** Every Postgres schema of the current project, system ones included. */
export function useSchemas() {
  return useQuery({ queryKey: ['schemas'], queryFn: fetchSchemas, staleTime: 60_000 });
}
