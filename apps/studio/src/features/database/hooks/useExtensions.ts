import { useQuery } from '@tanstack/react-query';
import { extensionsApi } from '@/features/database/api/extensions.api';

export function useExtensions() {
  return useQuery({ queryKey: ['pg-extensions'], queryFn: extensionsApi.list });
}
