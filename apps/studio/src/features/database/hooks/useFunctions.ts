import { useQuery } from '@tanstack/react-query';
import { keepPreviousFor } from '@/shared/lib/query';
import { functionsApi } from '@/features/database/api/functions.api';

export function useFunctions(schema: string) {
  return useQuery({
    // Keep the previous result on screen while the new selection loads.
    placeholderData: keepPreviousFor(schema),
    queryKey: ['pg-functions', schema],
    queryFn: () => functionsApi.list(schema),
  });
}
