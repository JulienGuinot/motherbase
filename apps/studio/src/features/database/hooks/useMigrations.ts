import { useQuery } from '@tanstack/react-query';
import { migrationsApi } from '@/features/database/api/migrations.api';

export function useMigrations() {
  return useQuery({ queryKey: ['migrations'], queryFn: migrationsApi.list });
}

export function useMigrationDetail(id: string) {
  return useQuery({
    queryKey: ['migration', id],
    queryFn: () => migrationsApi.detail(id),
  });
}
