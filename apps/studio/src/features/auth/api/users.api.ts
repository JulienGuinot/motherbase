import { api } from '@/shared/lib/api';
import type { AdminUser, ImpersonationSession, ProjectSession, UserAction, UserDetail } from '@/features/auth/types';

export interface ProjectSessionPage {
  sessions: ProjectSession[];
  page: number;
  perPage: number;
  total: number;
}

/** Applied by the server before it pages, so a match on any page is found. */
export interface UserListFilter {
  q?: string;
  role?: AdminUser['role'];
  verified?: boolean;
  anonymous?: boolean;
}

export interface UserPage {
  users: AdminUser[];
  page: number;
  perPage: number;
  total: number;
}

/** The server's ceiling on `per_page` for this list. */
const MAX_USERS_PER_PAGE = 500;

function listPage({ page, perPage, filter }: { page: number; perPage: number; filter: UserListFilter }) {
  return api
    .get('/admin/users', { params: { page, per_page: perPage, ...filter } })
    .then(r => r.data.data as UserPage);
}

export interface CreateUserPayload {
  email: string;
  username?: string;
  role: AdminUser['role'];
  password?: string;
  sendInvite: boolean;
  emailVerified: boolean;
}

export type UpdateUserPayload = Partial<Pick<AdminUser, 'firstName' | 'lastName' | 'username' | 'status'>>;

export const usersApi = {
  list: listPage,
  /** Every user the filter matches, a page at a time. For the CSV export. */
  listAll: async (filter: UserListFilter) => {
    const users: AdminUser[] = [];
    for (let page = 1; ; page += 1) {
      const result = await listPage({ page, perPage: MAX_USERS_PER_PAGE, filter });
      users.push(...result.users);
      if (result.users.length === 0 || users.length >= result.total) return users;
    }
  },
  detail: (id: string) => api.get(`/admin/users/${id}`).then(r => r.data.data as UserDetail),
  update: (id: string, payload: UpdateUserPayload) => api.patch(`/admin/users/${id}`, payload),
  setEmailVerified: (id: string, emailVerified: boolean) =>
    api.post(`/admin/users/${id}/email-verification`, { emailVerified }),
  action: (id: string, action: UserAction) =>
    api.post(`/admin/users/${id}/${action}`),
  resetPassword: (id: string, password: string) =>
    api.post(`/admin/users/${id}/reset-password`, { password }),
  create: (payload: CreateUserPayload) => api.post('/admin/users', payload),
  remove: (id: string) => api.delete(`/admin/users/${id}`),
  revokeSession: (id: string, sessionId: string) =>
    api.delete(`/admin/users/${id}/sessions/${sessionId}`),
  // Bounded on the server (SRV-9), so this is a page, not the whole list.
  listSessions: ({ page, perPage }: { page: number; perPage: number }) =>
    api
      .get('/admin/users/sessions', { params: { page, per_page: perPage } })
      .then(r => r.data.data as ProjectSessionPage),
  // Both calls are gated on `secrets.manage` and audited by the console proxy.
  // The token is a fresh session for the user, never one of their credentials.
  impersonate: (id: string) =>
    api.post(`/admin/users/${id}/impersonate`).then(r => r.data.data as ImpersonationSession),
  stopImpersonating: (id: string, token: string) =>
    api.post(`/admin/users/${id}/impersonate/stop`, { token }),
};
