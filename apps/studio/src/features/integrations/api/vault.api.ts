import { api } from '@/shared/lib/api';

// Shapes of `/admin/vault*`, see apps/server/services/admin/vault.service.ts.

export interface VaultSecret {
  id: string;
  name: string | null;
  description: string;
  keyId: string | null;
  /** False when the secret was sealed under an older CONFIG_ENCRYPTION_KEY. */
  keyMatches: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VaultList {
  enabled: boolean;
  keyConfigured: boolean;
  secrets: VaultSecret[];
}

export interface VaultSecretInput {
  name: string;
  secret: string;
  description: string;
}

export const vaultApi = {
  list: () => api.get('/admin/vault').then(r => r.data.data as VaultList),
  enable: () => api.post('/admin/vault/enable'),
  create: (input: VaultSecretInput) =>
    api.post('/admin/vault/secrets', input).then(r => r.data.data.secret as VaultSecret),
  update: (id: string, patch: Partial<VaultSecretInput>) =>
    api.patch(`/admin/vault/secrets/${id}`, patch).then(r => r.data.data.secret as VaultSecret),
  reveal: (id: string) => api.get(`/admin/vault/secrets/${id}/reveal`).then(r => r.data.data.secret as string),
  remove: (id: string) => api.delete(`/admin/vault/secrets/${id}`),
};
