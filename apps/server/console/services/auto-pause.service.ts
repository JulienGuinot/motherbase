import { errorMessage } from '../../lib/errors';
import type { RuntimeOptions } from '../lib/manifest';

interface AutoPauseDeps {
  registry: { list(): Promise<Array<{ name: string; status: string }>> };
  orchestrator: {
    readRuntimeOptions(name: string): Promise<RuntimeOptions>;
    stop(name: string): Promise<unknown>;
  };
  /** The project's own admin API: GET /metrics/requests. */
  admin: { request<T>(project: string, method: string, apiPath: string): Promise<T> };
  /** When the Console last proxied a Studio request to the project. */
  proxy: { lastAt(project: string): number };
  logs?: { push(entry: { level: 'info' | 'warn'; source: string; message: string }): void };
  now?: () => number;
}

interface ProjectActivity {
  lastActivityAt?: unknown;
  realtimeClients?: unknown;
}

/**
 * When the project was last used, or null when that cannot be established.
 *
 * Two clocks, because neither sees everything: the project API sees its own
 * callers but files Studio traffic under admin noise, and the Console sees the
 * Studio requests it proxies but nothing that arrives through Traefik.
 */
export function lastUsedAt(activity: ProjectActivity, proxiedAt: number, now: number): number | null {
  // An API image older than this feature reports no lastActivityAt. Unknown is
  // not idle: such a project is never paused.
  if (typeof activity.lastActivityAt !== 'number' || !Number.isFinite(activity.lastActivityAt)) return null;
  // An open websocket is a client waiting for events, however long ago it last sent HTTP.
  if (typeof activity.realtimeClients === 'number' && activity.realtimeClients > 0) return now;
  return Math.max(activity.lastActivityAt, proxiedAt);
}

/**
 * Stops the stacks of projects left unused for longer than their own
 * `autoPauseMinutes` (off unless a project sets it). A stopped stack keeps its
 * volumes and costs no memory; Start in the Console brings it back.
 *
 * Nothing wakes a paused project on its own: its hostname answers 404 until
 * someone starts it, and its cron jobs, scheduled functions and backups do not
 * run meanwhile. That is why this is opt-in per project.
 */
export class AutoPauseService {
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;

  constructor(private deps: AutoPauseDeps) {}

  start(intervalMs = 60_000) {
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
    // ponytail: one pass at a time, projects in sequence. An API that accepts
    // the connection and then hangs holds the pass for the admin client's
    // timeout; give the probe its own short timeout if that ever shows up.
    if (this.checking) return;
    this.checking = true;
    try {
      const projects = await this.deps.registry.list();
      for (const project of projects) {
        if (project.status !== 'running') continue;
        await this.pauseIfIdle(project.name).catch(error => {
          this.deps.logs?.push({ level: 'warn', source: 'console', message: `auto-pause check of ${project.name} failed: ${errorMessage(error)}` });
        });
      }
    } finally {
      this.checking = false;
    }
  }

  private async pauseIfIdle(name: string): Promise<void> {
    const { autoPauseMinutes } = await this.deps.orchestrator.readRuntimeOptions(name);
    if (!autoPauseMinutes) return;

    // Not answering means starting, updating or broken. None of those is idle.
    const activity = await this.deps.admin.request<ProjectActivity>(name, 'GET', '/metrics/requests').catch(() => null);
    if (!activity) return;

    const now = (this.deps.now ?? Date.now)();
    const usedAt = lastUsedAt(activity, this.deps.proxy.lastAt(name), now);
    if (usedAt === null || now - usedAt < autoPauseMinutes * 60_000) return;

    await this.deps.orchestrator.stop(name);
    this.deps.logs?.push({ level: 'info', source: 'console', message: `auto-paused ${name}: no request for ${autoPauseMinutes} min` });
  }
}
