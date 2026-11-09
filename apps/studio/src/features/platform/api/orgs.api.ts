import { api } from '@/shared/lib/api';
import type { AiProvider } from '@/features/assistant/api/assistant.api';

export type OrgRole = 'owner' | 'admin' | 'member';

export interface Org {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  role: OrgRole;
  projectCount: number;
}

export interface OrgMember {
  userId: string;
  role: OrgRole;
  createdAt: string;
  email: string | null;
}

// Tenant-org management (the layer above projects). Backed by /api/platform/orgs.
export const orgsApi = {
  list: () => api.get('/platform/orgs').then(r => r.data.data as Org[]),
  create: (name: string) => api.post('/platform/orgs', { name }).then(r => r.data.data as Org),
  rename: (id: string, name: string) => api.patch(`/platform/orgs/${id}`, { name }).then(r => r.data.data),
  remove: (id: string) => api.delete(`/platform/orgs/${id}`).then(r => r.data.data),
  members: (id: string) => api.get(`/platform/orgs/${id}/members`).then(r => r.data.data as OrgMember[]),
  addMember: (id: string, userId: string, role: OrgRole = 'member') =>
    api.post(`/platform/orgs/${id}/members`, { userId, role }).then(r => r.data.data),
  removeMember: (id: string, userId: string) =>
    api.delete(`/platform/orgs/${id}/members/${userId}`).then(r => r.data.data),
};

/**
 * One AI assistant key for every project an organization owns.
 *
 * The key is write-only: the console is told whether one is stored, never what
 * it is. A project that saves its own key in its `ai.assistant` settings
 * overrides this for that project alone.
 */
export interface OrgAiConfig {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  hasKey: boolean;
  updatedAt: string | null;
  /** Projects inheriting this config, limited to the ones the caller can see. */
  projects: string[];
  /** Org admin holding secrets.manage: the server decides, the form follows. */
  canManage: boolean;
  /** The providers the console accepts, straight from the server's registry. */
  providers: AiProvider[];
}

export interface OrgAiConfigInput {
  enabled: boolean;
  provider: string;
  model: string;
  /** Blank keeps the stored key. */
  apiKey?: string;
  baseUrl: string;
}

/** A save reports which projects could not be reached, so the console can name
 *  them instead of implying every project took the new key. */
export type OrgAiSaveResult = OrgAiConfig & { failed: string[] };

export const orgAiApi = {
  get: (id: string) => api.get(`/platform/orgs/${id}/ai`).then(r => r.data.data as OrgAiConfig),
  save: (id: string, body: OrgAiConfigInput) =>
    api.put(`/platform/orgs/${id}/ai`, body).then(r => r.data.data as OrgAiSaveResult),
  clear: (id: string) => api.delete(`/platform/orgs/${id}/ai`).then(r => r.data.data as OrgAiSaveResult),
};
