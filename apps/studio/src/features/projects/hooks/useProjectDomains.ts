'use client';

import { useQuery } from '@tanstack/react-query';
import { domainsApi, type ProjectDomains } from '@/features/projects/api/hosting.api';
import { useToastMutation } from '@/features/projects/hooks/useToastMutation';

export function useProjectDomains(project: string | undefined) {
  const key = ['project-domains', project ?? ''];
  const query = useQuery({ queryKey: key, queryFn: () => domainsApi.get(project!), enabled: Boolean(project) });
  const id = project!;
  return {
    query,
    create: useToastMutation(key, (hostname: string) => domainsApi.create(id, hostname), {
      success: 'Custom hostname added. Publish the DNS records next.', failure: 'Could not add the hostname',
    }),
    reverify: useToastMutation<void, ProjectDomains>(key, () => domainsApi.reverify(id), {
      success: d => (d.customHostname?.status === 'pending_verification' ? 'Records not found yet' : 'DNS verified'),
      failure: 'Verification failed',
    }),
    activate: useToastMutation<void, ProjectDomains>(key, () => domainsApi.activate(id), {
      success: 'Activated. The certificate is issued on the first request.', failure: 'Activation failed',
    }),
    remove: useToastMutation<void, ProjectDomains>(key, () => domainsApi.remove(id), { success: 'Custom hostname removed', failure: 'Delete failed' }),
    activateVanity: useToastMutation(key, (subdomain: string) => domainsApi.activateVanity(id, subdomain), {
      success: 'Vanity subdomain active', failure: 'Activation failed',
    }),
    removeVanity: useToastMutation<void, ProjectDomains>(key, () => domainsApi.removeVanity(id), { success: 'Vanity subdomain removed', failure: 'Delete failed' }),
  };
}
