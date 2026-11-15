import type { ProjectLimits } from '@/shared/lib/api';

/**
 * The containers every project runs, keyed by their compose service name (what
 * `docker stats` reports). The edge runtime is a container of its own, but it is
 * part of the project: it shares the quota and is listed with the others, never
 * beside them as if it were a project.
 */
export const PROJECT_SERVICES = [
  { service: 'api', label: 'API', hint: 'REST, auth and admin endpoints', cpuKey: 'apiCpus', memKey: 'apiMemMb' },
  { service: 'db', label: 'Database', hint: 'PostgreSQL', cpuKey: 'dbCpus', memKey: 'dbMemMb' },
  { service: 'minio', label: 'Storage', hint: 'Object storage for buckets and files', cpuKey: 'minioCpus', memKey: 'minioMemMb' },
  { service: 'edge-runtime', label: 'Edge functions', hint: 'Deno runtime, in its own container', cpuKey: 'edgeCpus', memKey: 'edgeMemMb' },
] as const satisfies ReadonlyArray<{
  service: string;
  label: string;
  hint: string;
  cpuKey: keyof ProjectLimits;
  memKey: keyof ProjectLimits;
}>;

/** The services a project runs: a turned-off edge runtime has no container, so no quota to show or count. */
export function runningServices(edgeRuntime: boolean) {
  return edgeRuntime ? PROJECT_SERVICES : PROJECT_SERVICES.filter(s => s.service !== 'edge-runtime');
}

export function serviceLabel(service: string | null): string {
  return PROJECT_SERVICES.find(s => s.service === service)?.label ?? service ?? 'Other';
}
