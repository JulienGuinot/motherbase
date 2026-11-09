import { api } from '@/shared/lib/api';

export type ApiKeyType = 'publishable' | 'secret';

export interface ApiKey {
  id: string;
  name: string;
  type: ApiKeyType;
  prefix: string;
  /** Present for publishable keys, which are public by design. Null for secrets. */
  token: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/** Creation is the only response that ever carries a secret key's clear value. */
export interface CreatedApiKey extends ApiKey {
  clearToken: string;
}

export const apiKeysApi = {
  list: () => api.get('/admin/api-keys').then(r => r.data.data.keys as ApiKey[]),
  create: (name: string, type: ApiKeyType) =>
    api.post('/admin/api-keys', { name, type }).then(r => r.data.data as CreatedApiKey),
  revoke: (id: string) => api.delete(`/admin/api-keys/${id}`).then(r => r.data.data as ApiKey),
};
