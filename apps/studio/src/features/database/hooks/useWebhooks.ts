import { useQuery } from '@tanstack/react-query';
import { keepPreviousFor } from '@/shared/lib/query';
import { webhooksApi } from '@/features/database/api/webhooks.api';

export function useWebhooks() {
  return useQuery({ queryKey: ['webhooks'], queryFn: webhooksApi.list });
}

export function useWebhookTables() {
  return useQuery({ queryKey: ['tables'], queryFn: webhooksApi.tables });
}

export function useWebhookDeliveries(id: string, active: boolean) {
  return useQuery({
    // Keep the previous result on screen while the new selection loads.
    placeholderData: keepPreviousFor(id),
    queryKey: ['webhook-deliveries', id],
    enabled: active,
    queryFn: () => webhooksApi.deliveries(id),
    refetchInterval: active ? 5000 : false,
  });
}

/** Non-row events the server publishes, for the trigger picker. */
export function useSystemEvents() {
  return useQuery({
    queryKey: ['webhook-system-events'],
    queryFn: webhooksApi.systemEvents,
    staleTime: 5 * 60_000,
  });
}
