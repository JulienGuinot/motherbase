import path from 'path';
import { SLUG_RE } from '../../constants/regex.constants';
import { resolveContainerName } from '../lib/docker';
import type { BranchInfo } from '../lib/manifest';
import type { ConsoleFs, ExecFn } from '../lib/ports';

// Project names are the only thing joined onto projectsDir. Enforce the same
// shape the routes accept, so a traversal attempt can never reach the fs even
// if a future caller forgets to validate.

type Fsx = Pick<ConsoleFs, 'readdir' | 'readFile'>;

export interface ProjectSummary {
  name: string;
  domain: string;
  storageDomain: string;
  createdAt: string;
  status: 'running' | 'stopped';
  apiUrl?: string;
  storageUrl?: string;
  /** Present on preview branches only. */
  branch?: BranchInfo;
}

/**
 * Lifetime of one `docker ps` sample. Short on purpose: it exists to collapse
 * the burst of concurrent requests a single page load makes, not to serve stale
 * state across a poll interval.
 */
const RUNNING_TTL_MS = 2_000;

export class Registry {
  constructor(
    private cfg: { projectsDir: string; traefikNetwork?: string },
    private fsx: Fsx,
    private exec: ExecFn,
  ) {}

  private runningCache: { at: number; value: Set<string> } | null = null;
  private runningInFlight: Promise<Set<string>> | null = null;

  /**
   * Names of the running containers, behind a short cache.
   *
   * Only the `docker ps` is cached: never the manifests below it. Every admin
   * request the Studio proxies calls `get()`, which calls `list()`, which used
   * to spawn `docker ps`: opening the table editor fires five requests and so
   * spawned five processes, and on a small VPS that is the most expensive thing
   * the console does per page. Concurrent callers now share one spawn, and a
   * burst arriving inside {@link RUNNING_TTL_MS} shares its result.
   *
   * Existence and identity still come from the filesystem on every call, so
   * create/404/409 checks see the truth. The only thing that can lag is a
   * project's up/down flag, by at most the TTL, and the console polls that
   * every 10s anyway.
   */
  private async runningNames(): Promise<Set<string>> {
    if (this.runningCache && Date.now() - this.runningCache.at < RUNNING_TTL_MS) {
      return this.runningCache.value;
    }
    if (this.runningInFlight) return this.runningInFlight;

    this.runningInFlight = this.exec('docker', ['ps', '--format', '{{.Names}}'])
      .catch(() => ({ stdout: '', stderr: '' }))
      .then(({ stdout }) => {
        const value = new Set(
          stdout
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean),
        );
        this.runningCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.runningInFlight = null;
      });
    return this.runningInFlight;
  }

  async list(): Promise<ProjectSummary[]> {
    const running = await this.runningNames();
    const dirs = await this.fsx.readdir(this.cfg.projectsDir).catch(() => [] as string[]);
    const out: ProjectSummary[] = [];
    for (const name of dirs) {
      try {
        const raw = await this.fsx.readFile(path.join(this.cfg.projectsDir, name, 'manifest.json'), 'utf8');
        const m = JSON.parse(raw);
        const isUp = [...running].some(n => n.startsWith(`${m.name}-api`));
        out.push({
          name: m.name,
          domain: m.domain,
          storageDomain: m.storageDomain,
          createdAt: m.createdAt,
          status: isUp ? 'running' : 'stopped',
          apiUrl: m.apiUrl,
          storageUrl: m.storageUrl,
          ...(m.branch ? { branch: m.branch } : {}),
        });
      } catch {
        // skip non-project dirs
      }
    }
    return out;
  }

  async get(name: string): Promise<ProjectSummary | undefined> {
    return (await this.list()).find(p => p.name === name);
  }

  async platformToken(name: string): Promise<string | undefined> {
    if (!SLUG_RE.test(name)) return undefined;
    const env = await this.fsx.readFile(path.join(this.cfg.projectsDir, name, '.env.prod'), 'utf8').catch(() => '');
    const line = env.split('\n').find(l => l.startsWith('PLATFORM_SERVICE_TOKEN='));
    return line?.slice('PLATFORM_SERVICE_TOKEN='.length).trim() || undefined;
  }

  async apiTarget(name: string): Promise<string | undefined> {
    const container = await resolveContainerName(this.exec, name);
    const { stdout } = await this.exec('docker', [
      'inspect',
      container,
      '--format',
      '{{json .NetworkSettings.Networks}}',
    ]).catch(() => ({ stdout: '', stderr: '' }));

    if (!stdout.trim()) return undefined;

    try {
      const networks = JSON.parse(stdout) as Record<string, { IPAddress?: string }>;
      const net = this.cfg.traefikNetwork ?? 'traefik_proxy';
      // Only proxy via the stable DNS alias on the traefik network. Never return an
      // IP from the internal bridge: the console is not attached to it, so that
      // address is unroutable and causes intermittent 502s. Absence on the traefik
      // network yields undefined so callers fall back to the `<name>-api` alias.
      if (!networks[net]) return undefined;
      return `http://${name}-api:5001`;
    } catch {
      return undefined;
    }
  }

  /**
   * Every address the console could reach this project's API on, best first. The
   * `<name>-api` alias is preferred because it survives container recreates, but
   * it only exists when the stack was brought up with the `aliases:` block (or
   * reconnected with `--alias`). Stacks predating that are reachable *only* by
   * container name or by their IP on the shared traefik network. Returning just
   * the alias is what turns those projects into a permanent 502.
   *
   * Addresses on other networks are still never returned: the console is not
   * attached to a project's `internal` bridge, so those are unroutable.
   */
  async apiTargets(name: string): Promise<string[]> {
    const alias = `http://${name}-api:5001`;
    const container = await resolveContainerName(this.exec, name);
    const { stdout } = await this.exec('docker', [
      'inspect',
      container,
      '--format',
      '{{json .NetworkSettings.Networks}}',
    ]).catch(() => ({ stdout: '', stderr: '' }));

    if (!stdout.trim()) return [alias];

    try {
      const networks = JSON.parse(stdout) as Record<string, { IPAddress?: string }>;
      const net = this.cfg.traefikNetwork ?? 'traefik_proxy';
      const shared = networks[net];
      if (!shared) return [alias];
      const ip = shared.IPAddress ? `http://${shared.IPAddress}:5001` : undefined;
      return [alias, `http://${container}:5001`, ...(ip ? [ip] : [])];
    } catch {
      return [alias];
    }
  }
}
