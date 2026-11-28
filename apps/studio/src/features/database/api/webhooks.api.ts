import { api } from '@/shared/lib/api';
import type { EventTableMeta } from '@/shared/lib/event-utils';
import type { Delivery, Hook } from '@/features/database/types';

export interface WebhookTableMeta extends EventTableMeta {
  primaryKey: string;
}

export interface WebhookTestResult { ok: boolean; status: number; ms: number }

/** A non-row event a webhook can subscribe to, as the dispatcher reports it. */
export interface SystemEventSpec {
  spec: string;
  label: string;
  description: string;
}

export const webhooksApi = {
  list: () => api.get('/admin/webhooks').then(r => r.data.data.webhooks as Hook[]),
  tables: () => api.get('/admin/tables').then(r => r.data.data.tables as WebhookTableMeta[]),
  /**
   * The events this server publishes that are not row changes.
   *
   * Read rather than mirrored: the picker offered application tables and a
   * hand-written list of auth actions, so `job_alert.created`, which the server
   * does publish, was subscribable only by wildcard or through the API.
   */
  systemEvents: () =>
    api.get('/admin/webhooks/events').then(r => r.data.data.events as SystemEventSpec[]),
  deliveries: (id: string) =>
    api.get(`/admin/webhooks/${id}/deliveries`).then(r => r.data.data.deliveries as Delivery[]),
  create: (payload: { name: string; url: string; events: string[] }) =>
    api.post('/admin/webhooks', payload),
  update: (id: string, patch: { name?: string; url?: string; events?: string[]; enabled?: boolean }) =>
    api.patch(`/admin/webhooks/${id}`, patch),
  remove: (id: string) => api.delete(`/admin/webhooks/${id}`),
  rotateSecret: (id: string) =>
    api.post(`/admin/webhooks/${id}/rotate-secret`).then(r => r.data.data as Hook),
  test: (id: string) =>
    api.post(`/admin/webhooks/${id}/test`).then(r => r.data.data as WebhookTestResult),
};
