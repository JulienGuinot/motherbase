import { api } from '@/shared/lib/api';

// Project admin routes for the infrastructure Supabase keeps under Project
// Settings (apps/server/controllers/admin/admin-infrastructure.controller.ts).

export type SigningKeyStatus = 'standby' | 'in_use' | 'previously_used' | 'revoked';
export type SigningAlgorithm = 'ES256' | 'RS256' | 'EdDSA';

export interface SigningKey {
  id: string;
  algorithm: SigningAlgorithm;
  status: SigningKeyStatus;
  publicJwk: Record<string, unknown>;
  createdAt: string;
}

export interface SigningKeys {
  keys: SigningKey[];
  issuer: string;
  jwksPath: string;
  legacy: { algorithm: 'HS256'; fingerprint: string; usedFor: string[] };
}

export const signingKeysApi = {
  list: () => api.get('/admin/auth/signing-keys').then(r => r.data.data as SigningKeys),
  create: (body: { algorithm?: SigningAlgorithm; privateKey?: Record<string, unknown> }) =>
    api.post('/admin/auth/signing-keys', body).then(r => r.data.data as SigningKey),
  rotate: (id: string) => api.post(`/admin/auth/signing-keys/${encodeURIComponent(id)}/rotate`).then(r => r.data.data as SigningKeys),
  revoke: (id: string) => api.post(`/admin/auth/signing-keys/${encodeURIComponent(id)}/revoke`).then(r => r.data.data as SigningKeys),
  remove: (id: string) => api.delete(`/admin/auth/signing-keys/${encodeURIComponent(id)}`).then(r => r.data.data as SigningKeys),
};

/** Where the database port can be reached from, which decides whether restrictions matter yet. */
export type DatabaseExposure = 'unpublished' | 'loopback' | 'public';

export interface NetworkRestrictions {
  dbAllowedCidrs: string[];
  dbAllowedCidrsV6: string[];
  /** `stored` outside a Console-managed stack: saved, not enforced. */
  status: 'applied' | 'stored';
  exposure: DatabaseExposure;
}

export interface SslEnforcement {
  enforced: boolean;
  status: 'applied' | 'stored';
  sslActive: boolean;
  exposure: DatabaseExposure;
}

export const databaseAccessApi = {
  networkRestrictions: () => api.get('/admin/network-restrictions').then(r => r.data.data as NetworkRestrictions),
  updateNetworkRestrictions: (body: { dbAllowedCidrs: string[]; dbAllowedCidrsV6: string[] }) =>
    api.put('/admin/network-restrictions', body).then(r => r.data.data as NetworkRestrictions),
  sslEnforcement: () => api.get('/admin/ssl-enforcement').then(r => r.data.data as SslEnforcement),
  updateSslEnforcement: (enforced: boolean) =>
    api.put('/admin/ssl-enforcement', { enforced }).then(r => r.data.data as SslEnforcement),
};

export type LogDrainType = 'webhook' | 'datadog' | 'loki';

export interface LogDrain {
  id: string;
  name: string;
  type: LogDrainType;
  /** Credentials come back as the settings sentinel; send it back unchanged to keep them. */
  config: Record<string, unknown>;
  enabled: boolean;
  deliveredCount: number;
  failedCount: number;
  droppedCount: number;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  /** Lines queued in memory right now. */
  pending: number;
  retrying: boolean;
  createdAt: string;
}

export const logDrainsApi = {
  list: () => api.get('/admin/log-drains').then(r => r.data.data.drains as LogDrain[]),
  create: (body: { name: string; type: LogDrainType; config: Record<string, unknown> }) =>
    api.post('/admin/log-drains', body).then(r => r.data.data as LogDrain),
  update: (id: string, body: { name?: string; enabled?: boolean; config?: Record<string, unknown> }) =>
    api.patch(`/admin/log-drains/${encodeURIComponent(id)}`, body).then(r => r.data.data as LogDrain),
  remove: (id: string) => api.delete(`/admin/log-drains/${encodeURIComponent(id)}`).then(r => r.data.data),
  test: (id: string) =>
    api.post(`/admin/log-drains/${encodeURIComponent(id)}/test`).then(r => r.data.data as { ok: boolean; status?: number; error?: string }),
};
