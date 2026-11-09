import type { PlatformSettingsService } from './settings.service';
import type { PlatformMetricsService, ProjectUsage } from './metrics.service';
import {
  OutboundHttpClient,
  type OutboundHttpClientLike,
  type OutboundRequestOptions,
} from '../../services/http/outbound-http-client.service';

const DEFAULT_CPU_THRESHOLD = 85;
const DEFAULT_MEM_THRESHOLD = 85;
const COOLDOWN_MS = 15 * 60_000;

interface RegistryLike {
  list(): Promise<Array<{ name: string }>>;
}

interface OrchestratorLike {
  readLimits?(project: string): Promise<any>;
}

export type AlertsFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number }>;

type AlertsHttpClient = {
  request(url: string, options?: OutboundRequestOptions): Promise<{ ok: boolean; status: number }>;
};

function normalizeHttpClient(client: OutboundHttpClientLike | AlertsFetchFn): AlertsHttpClient {
  if (typeof client !== 'function') return client;
  return {
    request: (url: string, options: OutboundRequestOptions = {}) =>
      client(url, {
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        body: String(options.body ?? ''),
      }),
  };
}

function effectivePercent(usage: ProjectUsage, kind: 'cpu' | 'mem'): number {
  if (kind === 'cpu') return usage.cpuLimit ? usage.cpuPct ?? 0 : usage.cpuPercent;
  return usage.memLimitBytes ? usage.memPct ?? 0 : usage.memPercent;
}

/** Build a webhook body that Discord/Slack will render nicely; anything else gets plain JSON. */
function buildPayload(
  url: string,
  project: string,
  cpuPercent: number,
  memPercent: number,
  cpuThreshold: number,
  memThreshold: number
): string {
  const text = `⚠️ Project "${project}" is over its resource alert threshold, CPU ${cpuPercent.toFixed(
    1
  )}% (limit ${cpuThreshold}%), memory ${memPercent.toFixed(1)}% (limit ${memThreshold}%).`;
  if (url.includes('discord.com/api/webhooks')) return JSON.stringify({ content: text });
  if (url.includes('hooks.slack.com')) return JSON.stringify({ text });
  return JSON.stringify({ project, cpuPercent, memPercent, cpuThreshold, memThreshold, at: new Date().toISOString() });
}

/**
 * Periodically checks per-project CPU/memory usage against the configured
 * thresholds and fires a webhook (Discord, Slack or a plain JSON endpoint) the
 * first time a project crosses the line, then stays quiet for COOLDOWN_MS so a
 * sustained overload doesn't spam the channel every tick.
 */
export class AlertsService {
  private lastNotified = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private readonly httpClient: AlertsHttpClient;

  constructor(
    private settings: PlatformSettingsService,
    private metrics: PlatformMetricsService,
    private registry: RegistryLike,
    private orchestrator: OrchestratorLike,
    httpClient: OutboundHttpClientLike | AlertsFetchFn = new OutboundHttpClient()
  ) {
    // Keep the historical fetch-function seam for unit tests while production
    // always uses the DNS-pinned client.
    this.httpClient = normalizeHttpClient(httpClient);
  }

  start(intervalMs = 30_000) {
    this.timer = setInterval(() => {
      this.checkOnce().catch(() => {});
    }, intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async checkOnce(): Promise<void> {
    const cfg = await this.settings.load();
    const webhookUrl = cfg.alertWebhookUrl;
    if (!webhookUrl) return;

    const cpuThreshold = Number(cfg.alertCpuThreshold) || DEFAULT_CPU_THRESHOLD;
    const memThreshold = Number(cfg.alertMemThreshold) || DEFAULT_MEM_THRESHOLD;

    let limitsByProject: Record<string, any> | undefined;
    try {
      const projs = await this.registry.list();
      if (Array.isArray(projs) && typeof this.orchestrator.readLimits === 'function') {
        limitsByProject = {};
        for (const p of projs) {
          if (!p?.name) continue;
          try {
            limitsByProject[p.name] = await this.orchestrator.readLimits(p.name);
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      limitsByProject = undefined;
    }

    const { projects } = await this.metrics.perProject(limitsByProject);
    const now = Date.now();

    for (const usage of projects) {
      const cpuPercent = effectivePercent(usage, 'cpu');
      const memPercent = effectivePercent(usage, 'mem');
      if (cpuPercent < cpuThreshold && memPercent < memThreshold) continue;

      const last = this.lastNotified.get(usage.project) ?? 0;
      if (now - last < COOLDOWN_MS) continue;

      try {
        const response = await this.httpClient.request(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: buildPayload(webhookUrl, usage.project, cpuPercent, memPercent, cpuThreshold, memThreshold),
        });
        if (response.ok) this.lastNotified.set(usage.project, now);
      } catch {
        /* best-effort: next tick retries */
      }
    }
  }
}
