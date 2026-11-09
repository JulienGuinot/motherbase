import fs from 'fs';
import path from 'path';
import {
  OutboundHttpClient,
  type OutboundHttpClientLike,
  type OutboundRequestOptions,
} from '../../services/http/outbound-http-client.service';

// Console self-update: CHECK step (non-destructive). Reports the running version
// and the newest version available on the configured release channel so the
// console can surface an "update available" banner. Applying the update (pull +
// recreate + migrate) is a separate, gated step added later.
//
// The channel is a single URL (`UPDATE_CHECK_URL`) pointing at whatever the
// operator publishes their images through. To stay registry-agnostic the check
// accepts the common JSON shapes rather than speaking one registry's API:
//   - { version: "1.2.3" }: a hand-published manifest
//   - { tags: ["1.0.0", "1.2.3", "latest"] }: a plain tag list
//   - { results: [{ name: "1.2.3" }] }: Docker Hub tags endpoint
// Non-semver tags (e.g. "latest") are ignored; the highest semver wins.

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(raw: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(raw).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** -1 if a<b, 0 if equal, 1 if a>b. */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

export function isNewer(candidate: string, current: string): boolean {
  const c = parseSemver(candidate);
  const cur = parseSemver(current);
  if (!c || !cur) return false;
  return compareSemver(c, cur) > 0;
}

/** Highest valid semver from a tag list, or null when none parse. */
export function pickLatest(tags: string[]): string | null {
  let best: { raw: string; ver: Semver } | null = null;
  for (const tag of tags) {
    const ver = parseSemver(tag);
    if (!ver) continue;
    if (!best || compareSemver(ver, best.ver) > 0) best = { raw: tag.replace(/^v/, ''), ver };
  }
  return best?.raw ?? null;
}

/** Pull candidate versions out of any of the accepted JSON shapes. */
export function extractVersions(payload: any): string[] {
  if (!payload || typeof payload !== 'object') return [];
  if (typeof payload.version === 'string') return [payload.version];
  if (Array.isArray(payload.tags)) return payload.tags.filter((t: unknown) => typeof t === 'string');
  if (Array.isArray(payload.results)) {
    return payload.results.map((r: any) => r?.name).filter((n: unknown) => typeof n === 'string');
  }
  return [];
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  configured: boolean;
  checkedAt: string;
  channel?: string;
  error?: string;
}

export interface UpdatePlan {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  configured: boolean;
  services: { name: string; from: string; to: string }[];
  commands: string[];
  notes: string[];
}

export interface UpdateServiceDeps {
  /** Release-channel URL. Empty = not configured (check is a no-op). */
  updateCheckUrl: string;
  /** Override the detected current version (tests / APP_VERSION). */
  version?: string;
  /** Legacy test seam. Production should use the DNS-pinned httpClient. */
  fetchImpl?: typeof fetch;
  httpClient?: OutboundHttpClientLike;
  timeoutMs?: number;
  /** Host path to the console stack compose file, shown in guided commands. */
  stackComposePath?: string;
  /** Motherbase-built services that move with a release. */
  stackServices?: string[];
}

/** Read the console's own version from package.json, once. */
function readPackageVersion(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'package.json'),
    path.join(__dirname, '..', '..', '..', 'package.json'),
    path.join(process.cwd(), 'package.json'),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (typeof pkg.version === 'string') return pkg.version;
    } catch {
      /* try next */
    }
  }
  return '0.0.0';
}

function fetchHttpClient(fetchImpl: typeof fetch): OutboundHttpClientLike {
  return {
    async request(url: string, options: OutboundRequestOptions = {}): Promise<Response> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
      try {
        return await fetchImpl(url, {
          method: options.method,
          headers: options.headers,
          body: options.body as BodyInit | undefined,
          redirect: 'error',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export class UpdateService {
  private readonly current: string;
  private readonly url: string;
  private readonly httpClient: OutboundHttpClientLike;
  private readonly timeoutMs: number;
  private readonly stackComposePath: string;
  private readonly stackServices: string[];

  constructor(deps: UpdateServiceDeps) {
    this.current = deps.version || process.env.APP_VERSION || readPackageVersion();
    this.url = deps.updateCheckUrl || '';
    this.httpClient = deps.httpClient ?? (deps.fetchImpl ? fetchHttpClient(deps.fetchImpl) : new OutboundHttpClient());
    this.timeoutMs = deps.timeoutMs ?? 5000;
    this.stackComposePath = deps.stackComposePath || 'deploy/console/docker-compose.yml';
    this.stackServices = deps.stackServices && deps.stackServices.length ? deps.stackServices : ['console', 'orchestrator'];
  }

  currentVersion(): string {
    return this.current;
  }

  async check(): Promise<UpdateStatus> {
    const base: UpdateStatus = {
      current: this.current,
      latest: null,
      updateAvailable: false,
      configured: !!this.url,
      checkedAt: new Date().toISOString(),
      channel: this.url || undefined,
    };
    if (!this.url) return base;

    try {
      const res = await this.httpClient.request(this.url, { timeoutMs: this.timeoutMs });
      if (!res.ok) return { ...base, error: `Release channel returned ${res.status}.` };
      const payload = await res.json().catch(() => null);
      const latest = pickLatest(extractVersions(payload));
      return {
        ...base,
        latest,
        updateAvailable: !!latest && isNewer(latest, this.current),
      };
    } catch {
      return { ...base, error: 'Release channel is unreachable.' };
    }
  }

  /**
   * A selective, guided update plan. Pure over check() + injected display config:
   * performs NO docker or registry access (the console has no socket). Returns the
   * exact host commands to pull + recreate only the motherbase console-stack
   * services and apply migrations. Empty when there is nothing to update.
   */
  async plan(): Promise<UpdatePlan> {
    const status = await this.check();
    const base: UpdatePlan = {
      current: status.current,
      latest: status.latest,
      updateAvailable: status.updateAvailable,
      configured: status.configured,
      services: [],
      commands: [],
      notes: [],
    };
    if (!status.updateAvailable || !status.latest) return base;

    const services = this.stackServices.map(name => ({ name, from: status.current, to: status.latest! }));
    const svcArgs = this.stackServices.join(' ');
    const compose = `docker compose -f ${this.stackComposePath}`;
    return {
      ...base,
      services,
      commands: [
        `${compose} pull ${svcArgs}`,
        `${compose} up -d ${svcArgs}`,
        `${compose} run --rm console npx prisma migrate deploy`,
      ],
      notes: [
        'Run these on the host where the console stack lives (repo root by default).',
        'Migrations run against the new image; the first two commands recreate only the motherbase services.',
        'Pinned third-party images (db/minio/mc) update only when their digest pins change in a release.',
      ],
    };
  }
}
