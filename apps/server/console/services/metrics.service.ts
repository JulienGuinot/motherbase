import os from 'os';
import { promises as fs } from 'fs';
import type { ResourceLimits } from '../lib/manifest';
import type { ExecFn } from '../lib/ports';
import { VOLUME_DF_ARGS } from '../orchestration/contracts';


const MIB = 1024 ** 2;

/** Sum a project's per-service limits into a whole-project cpu (cores) + mem (bytes) cap. */
function limitTotals(l: ResourceLimits): { cpuLimit: number; memLimitBytes: number } {
  return {
    cpuLimit: l.apiCpus + l.dbCpus + l.minioCpus + l.edgeCpus,
    memLimitBytes: (l.apiMemMb + l.dbMemMb + l.minioMemMb + l.edgeMemMb) * MIB,
  };
}

export interface HostMetrics {
  hostname: string;
  platform: string;
  uptimeSec: number;
  cpuCount: number;
  loadAvg: [number, number, number];
  loadPercent: number; // 1-min load normalised by cpu count, capped at 100
  memTotal: number;
  memFree: number;
  memUsed: number;
  memPercent: number;
}

export interface ContainerStat {
  name: string;
  project: string | null;
  service: string | null;
  cpuPercent: number;
  memPercent: number;
  memUsed: number;
  memLimit: number;
  netRx: number;
  netTx: number;
}

export interface ProjectUsage {
  project: string;
  containers: number;
  cpuPercent: number;
  memUsed: number;
  memPercent: number;
  // Present only when configured limits were injected into perProject().
  cpuLimit?: number; // total allotted cores across the project's services
  memLimitBytes?: number; // total allotted memory in bytes
  cpuPct?: number; // usage as a % of the configured cpu quota
  memPct?: number; // usage as a % of the configured mem quota
}

export interface HostDisk {
  path: string;
  total: number;
  used: number;
  free: number; // available to unprivileged writers (statfs bavail)
  percent: number;
}

export interface ProjectVolume {
  name: string; // compose volume key, e.g. "db_data"
  label: string;
  size: number;
}

export interface ProjectDisk {
  project: string;
  size: number;
  volumes: ProjectVolume[];
  /** Configured disk quota in bytes, joined in by GET /platform/disk. */
  quota?: number;
}

export interface DiskUsage {
  host: HostDisk | null;
  projects: ProjectDisk[];
  measuredAt: string | null; // when the volume sizes were taken
}

const VOLUME_LABELS: Record<string, string> = {
  db_data: 'Database',
  minio_data: 'Storage files',
  api_backups: 'Backups',
  api_data: 'App data',
};

// Parse docker's human sizes ("12.3MiB", "1.2GB", "512B") into bytes. docker stats
// uses binary units (MiB/GiB) for memory and decimal (MB/GB) for net/block IO; the
// table below covers both spellings.
const UNIT: Record<string, number> = {
  B: 1,
  KB: 1e3, KIB: 1024,
  MB: 1e6, MIB: 1024 ** 2,
  GB: 1e9, GIB: 1024 ** 3,
  TB: 1e12, TIB: 1024 ** 4,
};

function parseSize(s: string): number {
  const m = /([\d.]+)\s*([A-Za-z]+)/.exec(s.trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = UNIT[m[2].toUpperCase()] ?? 1;
  return Math.round(n * unit);
}

function parsePercent(s: string): number {
  return parseFloat(s.replace('%', '').trim()) || 0;
}

// Compose names containers "<project>-<service>-<n>". Split into project/service.
// Project slugs contain hyphens, so the service names that do too
// (deploy/docker-compose.prod.yml) are matched first: "acme-edge-runtime-1" is
// acme's edge-runtime, not a project called "acme-edge".
const CONTAINER_NAME = /^(.*?)-(edge-runtime|minio-init|[a-z0-9]+)-\d+$/i;

function splitName(name: string): { project: string | null; service: string | null } {
  const m = CONTAINER_NAME.exec(name);
  if (!m) return { project: null, service: null };
  return { project: m[1], service: m[2] };
}

/**
 * How long one `docker stats` sample is reused.
 *
 * `docker stats --no-stream` is not cheap: it asks the daemon for every
 * container and has to take two CPU samples to produce a percentage, so a call
 * costs on the order of a second of daemon work plus a process spawn. The
 * console polls this endpoint every 5s from the Projects page and again from
 * the Monitor tab, per open browser tab, and the alerts loop calls it every 30s
 * on top, so on a two-vCPU VPS with a couple of operators watching, `docker
 * stats` was running essentially continuously and competing with the very
 * projects it was measuring.
 *
 * Sitting just under the 5s client poll: every poll still gets a fresh sample,
 * but concurrent callers share one.
 */
const STATS_TTL_MS = 4_000;

/**
 * Volume sizes come from `docker system df -v`, which walks every volume on
 * disk. Disk grows slowly; five minutes stale is fine and keeps that walk rare.
 */
const DISK_TTL_MS = 5 * 60_000;

/** Parse `<volume>\t<size>` lines into per-project totals, largest first. */
export function parseVolumeUsage(stdout: string): ProjectDisk[] {
  const byProject = new Map<string, ProjectDisk>();
  for (const line of stdout.split('\n')) {
    const [name, size] = line.split('\t').map(s => s?.trim());
    const cut = name?.indexOf('_') ?? -1;
    if (!name || !size || cut <= 0) continue;
    const project = name.slice(0, cut);
    const key = name.slice(cut + 1);
    const bytes = parseSize(size);
    const entry = byProject.get(project) ?? { project, size: 0, volumes: [] };
    entry.size += bytes;
    entry.volumes.push({ name: key, label: VOLUME_LABELS[key] ?? key, size: bytes });
    byProject.set(project, entry);
  }
  for (const p of byProject.values()) p.volumes.sort((a, b) => b.size - a.size);
  return [...byProject.values()].sort((a, b) => b.size - a.size);
}

export class PlatformMetricsService {
  private statsCache: { at: number; value: ContainerStat[] } | null = null;
  private statsInFlight: Promise<ContainerStat[]> | null = null;

  private diskCache: { at: number; value: ProjectDisk[] } | null = null;
  private diskInFlight: Promise<ProjectDisk[]> | null = null;

  /**
   * `diskPath` is the directory whose filesystem is reported as the server
   * disk. ponytail: it is the projects dir, which on a single-disk VPS is the
   * same filesystem as Docker's data root; a separate Docker disk would need
   * `docker info`'s DockerRootDir measured instead.
   */
  constructor(private exec: ExecFn, private diskPath?: string) {}

  async hostDisk(): Promise<HostDisk | null> {
    if (!this.diskPath) return null;
    try {
      const s = await fs.statfs(this.diskPath);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      // used = total minus *all* free blocks; root-reserved blocks count as neither.
      const used = total - s.bfree * s.bsize;
      return { path: this.diskPath, total, used, free, percent: total ? Math.round((used / (used + free)) * 100) : 0 };
    } catch {
      return null;
    }
  }

  /** Server filesystem (fresh) + per-project Docker volume sizes (cached {@link DISK_TTL_MS}). */
  async disk(): Promise<DiskUsage> {
    const host = await this.hostDisk();
    const fresh = this.diskCache && Date.now() - this.diskCache.at < DISK_TTL_MS;
    if (!fresh && !this.diskInFlight) {
      this.diskInFlight = this.exec('docker', VOLUME_DF_ARGS)
        .then(({ stdout }) => {
          const value = parseVolumeUsage(stdout);
          this.diskCache = { at: Date.now(), value };
          return value;
        })
        .finally(() => { this.diskInFlight = null; });
    }
    const projects = fresh ? this.diskCache!.value : await this.diskInFlight!.catch(() => this.diskCache?.value ?? []);
    return { host, projects, measuredAt: this.diskCache ? new Date(this.diskCache.at).toISOString() : null };
  }

  host(): HostMetrics {
    const cpuCount = os.cpus().length || 1;
    const load = os.loadavg() as [number, number, number];
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const memUsed = memTotal - memFree;
    return {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      // Service (console process) uptime, not os.uptime(). The host/VM boot time
      // is meaningless here and can stay huge across container restarts.
      uptimeSec: Math.round(process.uptime()),
      cpuCount,
      loadAvg: load,
      loadPercent: Math.min(100, Math.round((load[0] / cpuCount) * 100)),
      memTotal,
      memFree,
      memUsed,
      memPercent: memTotal ? Math.round((memUsed / memTotal) * 100) : 0,
    };
  }

  /**
   * Container stats, at most one `docker stats` per {@link STATS_TTL_MS} and at
   * most one in flight at a time. Ten browser tabs polling in step now cost the
   * daemon exactly what one tab costs.
   */
  async containers(): Promise<ContainerStat[]> {
    const fresh = this.statsCache && Date.now() - this.statsCache.at < STATS_TTL_MS;
    if (fresh) return this.statsCache!.value;
    // A second caller arriving mid-sample waits for that sample rather than
    // starting a competing one.
    if (this.statsInFlight) return this.statsInFlight;

    this.statsInFlight = this.collectContainers()
      .then(value => {
        this.statsCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.statsInFlight = null;
      });
    return this.statsInFlight;
  }

  private async collectContainers(): Promise<ContainerStat[]> {
    const { stdout } = await this.exec('docker', [
      'stats', '--no-stream', '--format', '{{json .}}',
    ]).catch(() => ({ stdout: '', stderr: '' }));

    const stats: ContainerStat[] = [];
    for (const line of stdout.split('\n').map(l => l.trim()).filter(Boolean)) {
      try {
        const j = JSON.parse(line);
        const name: string = j.Name ?? j.Container ?? '';
        const [memUsedRaw, memLimitRaw] = String(j.MemUsage ?? '0B / 0B').split('/');
        const [netRxRaw, netTxRaw] = String(j.NetIO ?? '0B / 0B').split('/');
        const { project, service } = splitName(name);
        stats.push({
          name,
          project,
          service,
          cpuPercent: parsePercent(j.CPUPerc ?? '0%'),
          memPercent: parsePercent(j.MemPerc ?? '0%'),
          memUsed: parseSize(memUsedRaw ?? '0B'),
          memLimit: parseSize(memLimitRaw ?? '0B'),
          netRx: parseSize(netRxRaw ?? '0B'),
          netTx: parseSize(netTxRaw ?? '0B'),
        });
      } catch {
        // skip malformed rows
      }
    }
    return stats;
  }

  /**
   * Aggregate per-container stats up to the owning project. When `limitsByProject`
   * is supplied, each project entry is also annotated with its configured quota
   * (`cpuLimit`/`memLimitBytes`) and usage-vs-quota percentages (`cpuPct`/`memPct`).
   * Called with no argument it behaves exactly as before (usage only).
   */
  async perProject(
    limitsByProject?: Record<string, ResourceLimits>,
  ): Promise<{ host: HostMetrics; containers: ContainerStat[]; projects: ProjectUsage[] }> {
    const containers = await this.containers();
    const byProject = new Map<string, ProjectUsage>();
    for (const c of containers) {
      if (!c.project) continue;
      const u = byProject.get(c.project) ?? { project: c.project, containers: 0, cpuPercent: 0, memUsed: 0, memPercent: 0 };
      u.containers += 1;
      u.cpuPercent += c.cpuPercent;
      u.memUsed += c.memUsed;
      u.memPercent += c.memPercent;
      byProject.set(c.project, u);
    }
    const round = (n: number) => Math.round(n * 10) / 10;
    const projects = [...byProject.values()]
      .map(u => {
        const base: ProjectUsage = { ...u, cpuPercent: round(u.cpuPercent), memPercent: round(u.memPercent) };
        const limits = limitsByProject?.[u.project];
        if (!limits) return base;
        const { cpuLimit, memLimitBytes } = limitTotals(limits);
        // docker's CPUPerc is normalised so 100% == 1 core; a cpuLimit of N cores
        // means N*100% is the ceiling. Guard divide-by-zero on both axes.
        base.cpuLimit = cpuLimit;
        base.memLimitBytes = memLimitBytes;
        base.cpuPct = cpuLimit > 0 ? round(u.cpuPercent / cpuLimit) : 0;
        base.memPct = memLimitBytes > 0 ? round((u.memUsed / memLimitBytes) * 100) : 0;
        return base;
      })
      .sort((a, b) => b.cpuPercent - a.cpuPercent);
    return { host: this.host(), containers, projects };
  }
}
