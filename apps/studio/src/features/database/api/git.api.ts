import { api } from '@/shared/lib/api';

/** Mirrors `GitLinkStatus` in apps/server/services/admin/git/git-repo.service.ts. */
export interface GitLinkStatus {
  /** The GitHub OAuth App credentials are set, so connecting is possible at all. */
  configured: boolean;
  connected: boolean;
  accountLogin: string | null;
  owner: string | null;
  repo: string | null;
  branch: string;
  migrationsPath: string;
  webhookInstalled: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: 'ok' | 'failed' | null;
  lastSyncMessage: string | null;
  lastSyncSha: string | null;
}

export interface GitRepoOption {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string | null;
}

export interface GitSyncResult {
  applied: string[];
  skipped: string[];
  failed: { name: string; message: string } | null;
  sha: string | null;
}

export interface GitLinkInput {
  owner: string;
  repo: string;
  branch: string;
  migrationsPath: string;
}

export const gitApi = {
  status: () => api.get('/admin/git/status').then(r => r.data.data as GitLinkStatus),
  authorizeUrl: () => api.get('/admin/git/authorize').then(r => r.data.data.url as string),
  completeAuthorization: (code: string, state: string) =>
    api.post('/admin/git/callback', { code, state }).then(r => r.data.data as GitLinkStatus),
  repos: () => api.get('/admin/git/repos').then(r => r.data.data.repos as GitRepoOption[]),
  link: (input: GitLinkInput) => api.post('/admin/git/link', input).then(r => r.data.data as GitLinkStatus),
  unlink: () => api.delete('/admin/git/link').then(r => r.data.data as GitLinkStatus),
  sync: () => api.post('/admin/git/sync').then(r => r.data.data as GitSyncResult),
};
