// Fields a limits PATCH may set, grouped by unit so bounds can be applied.
export const CPU_LIMIT_KEYS = ['apiCpus', 'dbCpus', 'minioCpus', 'edgeCpus'] as const;
export const MEM_LIMIT_KEYS = ['apiMemMb', 'dbMemMb', 'minioMemMb', 'edgeMemMb'] as const;
export const DISK_LIMIT_KEY = 'diskGb';
export const LIMIT_KEYS = [...CPU_LIMIT_KEYS, ...MEM_LIMIT_KEYS, DISK_LIMIT_KEY];

const MIN_CPUS = 0.1;
const MIN_MEM_MB = 128;
const MIN_DISK_GB = 1;
const FALLBACK_MAX_CPUS = 64;
const FALLBACK_MAX_DISK_GB = 10_000;
export const GIB = 1024 ** 3;

export interface LimitBounds {
  maxCpus: number;
  maxDiskGb: number;
}

/**
 * A project cannot be promised more cores than the host has, nor more than the
 * whole server disk. Either falls back to a generous ceiling when unknown.
 */
export async function hostLimitBounds(metrics: any): Promise<LimitBounds> {
  let maxCpus = FALLBACK_MAX_CPUS;
  try {
    const cpuCount = metrics?.host?.().cpuCount;
    if (typeof cpuCount === 'number' && cpuCount > 0) maxCpus = cpuCount;
  } catch { /* keep fallback */ }
  const hostDisk = await metrics?.hostDisk?.().catch(() => null);
  const maxDiskGb = hostDisk?.total ? Math.max(MIN_DISK_GB, Math.floor(hostDisk.total / GIB)) : FALLBACK_MAX_DISK_GB;
  return { maxCpus, maxDiskGb };
}

/**
 * Validate a partial limits patch. Only recognised keys are considered; every
 * provided value must be a finite number within bounds (cpus MIN_CPUS..maxCpus,
 * mem >= MIN_MEM_MB, disk a whole MIN_DISK_GB..maxDiskGb). Returns the cleaned
 * patch, or an error message.
 */
export function validateLimitsPatch(
  body: any,
  { maxCpus, maxDiskGb }: LimitBounds,
): { patch: Record<string, number>; error?: string } {
  const patch: Record<string, number> = {};
  const bad = (msg: string) => ({ patch: {}, error: msg });
  for (const key of CPU_LIMIT_KEYS) {
    if (body[key] === undefined) continue;
    const n = Number(body[key]);
    if (!Number.isFinite(n)) return bad(`${key} must be a number`);
    if (n < MIN_CPUS || n > maxCpus) return bad(`${key} must be between ${MIN_CPUS} and ${maxCpus} cpus`);
    patch[key] = n;
  }
  for (const key of MEM_LIMIT_KEYS) {
    if (body[key] === undefined) continue;
    const n = Number(body[key]);
    if (!Number.isFinite(n)) return bad(`${key} must be a number`);
    if (n < MIN_MEM_MB) return bad(`${key} must be at least ${MIN_MEM_MB} MB`);
    patch[key] = Math.round(n);
  }
  if (body[DISK_LIMIT_KEY] !== undefined) {
    const n = Number(body[DISK_LIMIT_KEY]);
    if (!Number.isInteger(n)) return bad(`${DISK_LIMIT_KEY} must be a whole number of GB`);
    if (n < MIN_DISK_GB || n > maxDiskGb) return bad(`${DISK_LIMIT_KEY} must be between ${MIN_DISK_GB} and ${maxDiskGb} GB`);
    patch[DISK_LIMIT_KEY] = n;
  }
  if (Object.keys(patch).length === 0) return bad('no valid limit fields provided');
  return { patch };
}
