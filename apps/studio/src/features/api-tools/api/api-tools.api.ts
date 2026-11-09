import { api } from '@/shared/lib/api';
import type { EdgeFn, FnLog, InvokeResult, Secret } from '@/features/api-tools/types';
import type { RestResource } from '@/features/api-tools/lib/endpoints';

export const apiToolsApi = {
  /**
   * What the REST router actually serves: `public` base tables, with their real
   * primary keys. Distinct from `/admin/tables`, which is every table in every
   * schema and is what the API Docs screen used to document endpoints from.
   */
  restResources: () =>
    api.get('/admin/rest/resources').then(r => r.data.data.resources as RestResource[]),
  request: (config: { url: string; method: string; data?: unknown }) => api.request(config),

  edgeFunctions: () =>
    api.get('/admin/edge-functions').then(r => r.data.data.functions as EdgeFn[]),
  edgeFunctionLogs: (id: string) =>
    api.get(`/admin/edge-functions/${id}/logs`).then(r => r.data.data.logs as FnLog[]),
  createEdgeFunction: (body: { name: string; route: string; code: string }) =>
    api.post('/admin/edge-functions', body),
  updateEdgeFunction: (id: string, body: Partial<{ code: string; schedule: string | null; enabled: boolean; isPublic: boolean }>) =>
    api.patch(`/admin/edge-functions/${id}`, body),
  deleteEdgeFunction: (id: string) => api.delete(`/admin/edge-functions/${id}`),
  invokeEdgeFunction: (id: string, body: unknown) =>
    api.post(`/admin/edge-functions/${id}/invoke`, body).then(r => r.data.data as InvokeResult),

  secrets: () => api.get('/admin/edge-secrets').then(r => r.data.data.secrets as Secret[]),
  saveSecret: (name: string, value: string) => api.put('/admin/edge-secrets', { name, value }),
  deleteSecret: (name: string) => api.delete(`/admin/edge-secrets/${encodeURIComponent(name)}`),
};
