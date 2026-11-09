import { api } from '@/shared/lib/api';
import type { ChannelInfo, RealtimeConfig, RealtimeEvent } from '@/features/database/types';
import type { PgPolicy } from '@/features/database/lib/rls-api';
import type { RealtimePolicyDraft } from '@/features/database/lib/realtime-policies';

/** Mirrors `RealtimeQueueHealth` on the server. */
export interface RealtimeQueueHealth {
  pending: number;
  processing: number;
  failed: number;
  oldestPendingAt: string | null;
  lastFailure: { at: string; model: string; action: string; error: string | null } | null;
  /** False when the queue could not be read. An unread queue is not an empty one. */
  measured: boolean;
}

export const realtimeApi = {
  channels: () =>
    api.get('/admin/realtime/channels').then(r => r.data.data.channels as ChannelInfo[]),
  events: (channel: string | null) => {
    const params = channel ? `?channel=${encodeURIComponent(channel)}` : '';
    return api.get(`/admin/realtime/events${params}`).then(r => r.data.data.events as RealtimeEvent[]);
  },
  presence: (channel: string) =>
    api.get(`/admin/realtime/channels/${encodeURIComponent(channel)}/presence`).then(r => r.data.data.users as string[]),

  /**
   * Depth of the durable delivery queue.
   *
   * The inspector shows live channels and the last few hundred events held in
   * memory, which says nothing about events that were accepted and never
   * delivered. Those sit in `platform.realtime_outbox` and were reachable only
   * by reading the system table by hand.
   */
  queue: () =>
    api
      .get('/admin/realtime/queue')
      .then(r => r.data.data as { queue: RealtimeQueueHealth; inspectorRetained: number }),
  config: () => api.get('/admin/realtime/config').then(r => r.data.data as RealtimeConfig),
  setModels: (models: string[]) => api.patch('/admin/realtime/config', { models }),
  setRespectRls: (model: string, respectRls: boolean) =>
    api.patch('/admin/realtime/config/respect-rls', { model, respectRls }),

  /** Realtime Authorization: the RLS policies on `realtime.messages`. */
  policies: () => api.get('/admin/realtime/policies').then(r => r.data.data.policies as PgPolicy[]),
  createPolicy: (draft: RealtimePolicyDraft) => api.post('/admin/realtime/policies', draft),
  dropPolicy: (name: string) => api.delete(`/admin/realtime/policies/${encodeURIComponent(name)}`),
};
