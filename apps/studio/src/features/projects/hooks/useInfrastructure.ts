'use client';

import { useQuery } from '@tanstack/react-query';
import {
  databaseAccessApi,
  logDrainsApi,
  signingKeysApi,
  type LogDrainType,
  type SigningAlgorithm,
} from '@/features/projects/api/infrastructure.api';
import { useToastMutation } from '@/features/projects/hooks/useToastMutation';

const SIGNING_KEYS = ['project-signing-keys'];
const NETWORK = ['project-network-restrictions'];
const SSL = ['project-ssl-enforcement'];
const DRAINS = ['project-log-drains'];

export function useSigningKeys() {
  return {
    query: useQuery({ queryKey: SIGNING_KEYS, queryFn: signingKeysApi.list }),
    create: useToastMutation(SIGNING_KEYS, (body: { algorithm?: SigningAlgorithm; privateKey?: Record<string, unknown> }) =>
      signingKeysApi.create(body), { success: 'Standby key created', failure: 'Key not created' }),
    rotate: useToastMutation(SIGNING_KEYS, signingKeysApi.rotate, {
      success: 'Rotated. New tokens are signed with this key.', failure: 'Rotation failed',
    }),
    revoke: useToastMutation(SIGNING_KEYS, signingKeysApi.revoke, {
      success: 'Revoked. Tokens it signed no longer verify.', failure: 'Revoke failed',
    }),
    remove: useToastMutation(SIGNING_KEYS, signingKeysApi.remove, { success: 'Key deleted', failure: 'Delete failed' }),
  };
}

export function useDatabaseAccess() {
  return {
    network: useQuery({ queryKey: NETWORK, queryFn: databaseAccessApi.networkRestrictions }),
    ssl: useQuery({ queryKey: SSL, queryFn: databaseAccessApi.sslEnforcement }),
    updateNetwork: useToastMutation(NETWORK, databaseAccessApi.updateNetworkRestrictions, {
      success: 'Network restrictions saved', failure: 'Restrictions not saved',
    }),
    updateSsl: useToastMutation(SSL, databaseAccessApi.updateSslEnforcement, {
      success: s => (s.enforced ? 'SSL is now required' : 'SSL is now optional'), failure: 'SSL setting not saved',
    }),
  };
}

export function useLogDrains() {
  return {
    query: useQuery({ queryKey: DRAINS, queryFn: logDrainsApi.list, refetchInterval: 10_000 }),
    create: useToastMutation(DRAINS, (body: { name: string; type: LogDrainType; config: Record<string, unknown> }) =>
      logDrainsApi.create(body), { success: 'Log drain added', failure: 'Drain not added' }),
    update: useToastMutation(DRAINS, ({ id, ...body }: { id: string; enabled?: boolean }) => logDrainsApi.update(id, body), {
      success: d => (d.enabled ? `${d.name} enabled` : `${d.name} paused`), failure: 'Update failed',
    }),
    remove: useToastMutation(DRAINS, logDrainsApi.remove, { success: 'Log drain removed', failure: 'Delete failed' }),
    test: useToastMutation(DRAINS, logDrainsApi.test, {
      success: r => (r.ok ? 'Test line delivered' : `Delivery failed: ${r.error ?? `HTTP ${r.status}`}`),
      failure: 'Test failed',
    }),
  };
}
