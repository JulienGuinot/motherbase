import { api } from '@/shared/lib/api';

export interface ConsoleSession {
  id: string;
  token: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export const consoleSessionsApi = {
  list: () => api.get<ConsoleSession[]>('/auth/list-sessions').then(response => response.data),
  revoke: (token: string) => api.post('/auth/revoke-session', { token }),
  revokeOthers: () => api.post('/auth/revoke-other-sessions'),
};
