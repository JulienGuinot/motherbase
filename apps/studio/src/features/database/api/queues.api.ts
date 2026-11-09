import { api } from '@/shared/lib/api';

// Shapes of `/admin/queues*`, see apps/server/services/admin/queue.service.ts.

export type QueueType = 'basic' | 'unlogged' | 'partitioned';
export type QueueRole = 'anon' | 'authenticated';
export type QueuePrivilege = 'select' | 'insert' | 'update' | 'delete';
export type QueuePrivileges = Record<QueuePrivilege, boolean>;

export interface QueueStatus {
  available: boolean;
  installed: boolean;
  version: string | null;
  exposed: boolean;
  partitionedAvailable: boolean;
}

export interface QueueInfo {
  name: string;
  type: QueueType;
  createdAt: string;
  rlsEnabled: boolean;
  length: number;
  visibleLength: number;
  newestMsgAgeSec: number | null;
  oldestMsgAgeSec: number | null;
  totalMessages: number;
}

/** pgmq's own record shape, the one `pgmq_public.read` returns too. */
export interface QueueMessage {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: unknown;
  headers: unknown;
  archived_at?: string;
}

export interface QueuePermissions {
  rlsEnabled: boolean;
  roles: Record<QueueRole, QueuePrivileges>;
}

export type QueueList = QueueStatus & { queues: QueueInfo[] };

const path = (name: string) => `/admin/queues/${encodeURIComponent(name)}`;

export const queuesApi = {
  list: () => api.get('/admin/queues').then(r => r.data.data as QueueList),
  enable: () => api.post('/admin/queues/enable'),
  setExposed: (enabled: boolean) => api.put('/admin/queues/expose', { enabled }),
  create: (input: { name: string; type: QueueType; rls: boolean }) =>
    api.post('/admin/queues', input).then(r => r.data.data.queue as QueueInfo),
  drop: (name: string) => api.delete(path(name)),
  purge: (name: string) => api.post(`${path(name)}/purge`).then(r => r.data.data.purged as number),
  messages: (name: string, options: { archived?: boolean; limit: number; offset: number }) =>
    api
      .get(`${path(name)}/messages`, { params: { ...options, archived: options.archived ? 'true' : undefined } })
      .then(r => r.data.data as { messages: QueueMessage[]; total: number }),
  send: (name: string, message: unknown, delay: number) =>
    api.post(`${path(name)}/messages`, { message, delay }).then(r => r.data.data.msgIds as number[]),
  read: (name: string, vt: number, qty: number) =>
    api.post(`${path(name)}/read`, { vt, qty }).then(r => r.data.data.messages as QueueMessage[]),
  archive: (name: string, msgId: number) => api.post(`${path(name)}/messages/${msgId}/archive`),
  deleteMessage: (name: string, msgId: number) => api.delete(`${path(name)}/messages/${msgId}`),
  permissions: (name: string) =>
    api.get(`${path(name)}/permissions`).then(r => r.data.data as QueuePermissions),
  setPermissions: (name: string, patch: Partial<QueuePermissions>) =>
    api.put(`${path(name)}/permissions`, patch).then(r => r.data.data as QueuePermissions),
};
