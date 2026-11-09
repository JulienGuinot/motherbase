import { useQuery } from '@tanstack/react-query';
import { keepPreviousFor } from '@/shared/lib/query';
import { triggersApi } from '@/features/database/api/triggers.api';

export function useTriggers(schema: string) {
  return useQuery({
    // Keep the previous result on screen while the new selection loads.
    placeholderData: keepPreviousFor(schema),
    queryKey: ['pg-triggers', schema],
    queryFn: () => triggersApi.list(schema),
  });
}

export function useTriggerTables(schema: string) {
  return useQuery({
    queryKey: ['schema-tables', schema],
    queryFn: () => triggersApi.tables(schema),
  });
}

export function useTriggerFunctions(schema: string) {
  return useQuery({
    queryKey: ['trigger-functions', schema],
    queryFn: () => triggersApi.triggerFunctions(schema),
  });
}
