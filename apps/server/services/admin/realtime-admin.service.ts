import type { Server as SocketIOServer } from 'socket.io';
import BaseContext from '../../context/base-context';
import { isRestBlockedModel } from '../rest-api/policy-types';

const MAX_EVENTS = 200;
const REALTIME_MODELS_KEY = 'realtime.models';
const REALTIME_RESPECT_RLS_KEY = 'realtime.respectRls';

export interface RealtimeEvent {
  channel: string;
  event: string;
  payload: any;
  at: number;
}

export interface ChannelInfo {
  name: string;
  clientCount: number;
}

export interface RealtimeModelInfo {
  model: string;
  dbName: string;
  dynamic: boolean;
  riskLevel: 'public' | 'restricted' | 'private' | 'none';
}

export interface RealtimeConfig {
  models: string[];
  availableModels: Array<RealtimeModelInfo & { respectRls: boolean }>;
  defaultEnabled: boolean;
  configured: boolean;
}

/** Health of the durable delivery queue behind realtime. */
export interface RealtimeQueueHealth {
  pending: number;
  processing: number;
  /** Events that exhausted their retries and will never be delivered. */
  failed: number;
  /** ISO timestamp of the oldest event still waiting, or null when the queue is empty. */
  oldestPendingAt: string | null;
  /** Newest permanent failure, so an operator can find it in the logs. */
  lastFailure: { at: string; model: string; action: string; error: string | null } | null;
  /** False when the queue could not be read. Never report an unread queue as empty. */
  measured: boolean;
}

/** How many events the in-memory inspector retains, so the screen can say so. */
export const REALTIME_INSPECTOR_RETAINED = MAX_EVENTS;

export class RealtimeAdminService extends BaseContext {
  private ring: RealtimeEvent[] = [];
  private io: SocketIOServer | null = null;

  /**
   * Queue depth, not traffic.
   *
   * The inspector shows live channels and the last {@link MAX_EVENTS} events in
   * memory, which says nothing about events that were accepted and never
   * delivered. Those sit in `platform.realtime_outbox` and were reachable only
   * by reading the system table by hand.
   */
  async queueHealth(): Promise<RealtimeQueueHealth> {
    const empty: RealtimeQueueHealth = {
      pending: 0,
      processing: 0,
      failed: 0,
      oldestPendingAt: null,
      lastFailure: null,
      measured: false,
    };
    try {
      const [grouped, oldest, failure] = await Promise.all([
        this.di.prisma.realtimeOutbox.groupBy({ by: ['status'], _count: { _all: true } }),
        this.di.prisma.realtimeOutbox.findFirst({
          where: { status: 'pending' },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        this.di.prisma.realtimeOutbox.findFirst({
          where: { status: 'failed' },
          orderBy: { updatedAt: 'desc' },
          select: { updatedAt: true, model: true, action: true, lastError: true },
        }),
      ]);

      const count = (status: string) =>
        Number(grouped.find((row: { status: string }) => row.status === status)?._count?._all ?? 0);

      return {
        pending: count('pending'),
        processing: count('processing'),
        failed: count('failed'),
        oldestPendingAt: oldest?.createdAt.toISOString() ?? null,
        lastFailure: failure
          ? {
              at: failure.updatedAt.toISOString(),
              model: failure.model,
              action: failure.action,
              error: failure.lastError ?? null,
            }
          : null,
        measured: true,
      };
    } catch {
      // `measured: false` so the console renders "unavailable", not "healthy".
      return empty;
    }
  }

  setIO(io: SocketIOServer): void {
    this.io = io;
  }

  /** Open websocket connections. A subscribed client sends no HTTP, yet the project is in use. */
  connectedClients(): number {
    return this.io?.engine.clientsCount ?? 0;
  }

  pushEvent(event: RealtimeEvent): void {
    this.ring.push(event);
    if (this.ring.length > MAX_EVENTS) this.ring.shift();
  }

  getRecentEvents(channel?: string): RealtimeEvent[] {
    const events = channel ? this.ring.filter(event => event.channel === channel) : [...this.ring];
    return events.reverse();
  }

  async getChannels(): Promise<ChannelInfo[]> {
    if (!this.io) return [];
    const rooms = this.io.sockets.adapter.rooms;
    const result: ChannelInfo[] = [];

    for (const [name, sockets] of rooms.entries()) {
      if (this.io.sockets.sockets.has(name)) continue;
      result.push({ name, clientCount: sockets.size });
    }

    return result.sort((a, b) => b.clientCount - a.clientCount);
  }

  async getPresence(channel: string): Promise<string[]> {
    if (!this.io) return [];
    const sockets = await this.io.in(channel).fetchSockets();
    return sockets.map(socket => (socket.data as any)?.user?.id ?? socket.id);
  }

  async getConfig(): Promise<RealtimeConfig> {
    const availableModels = await this.getAvailableModels();
    const configuredModels = await this.getConfiguredModels();
    const models = configuredModels === null
      ? availableModels.map(model => model.model)
      : this.sanitizeModels(configuredModels, availableModels);

    const respectRlsMap = await this.getRespectRlsMap();
    const enrichedModels = availableModels.map(model => ({
      ...model,
      respectRls: respectRlsMap[model.model] !== false,
    }));

    return {
      models,
      availableModels: enrichedModels,
      defaultEnabled: true,
      configured: configuredModels !== null,
    };
  }

  async getEnabledModels(): Promise<string[]> {
    return (await this.getConfig()).models;
  }

  async isModelEnabled(modelName: string): Promise<boolean> {
    const availableModels = await this.getAvailableModels();
    const model = availableModels.find(item => item.model === modelName || item.dbName === modelName);
    if (!model) return false;

    const configuredModels = await this.getConfiguredModels();
    if (configuredModels === null) return true;
    return this.sanitizeModels(configuredModels, availableModels).includes(model.model);
  }

  async setEnabledModels(models: string[]): Promise<string[]> {
    const sanitized = this.sanitizeModels(models, await this.getAvailableModels());
    await this.di.prisma.appSetting.upsert({
      where: { key: REALTIME_MODELS_KEY },
      update: { value: sanitized },
      create: { key: REALTIME_MODELS_KEY, value: sanitized },
    });
    return sanitized;
  }

  async getModelConfig(modelName: string): Promise<{ respectRls: boolean }> {
    // Hot path (called once per broadcast): read the override map directly and
    // avoid getAvailableModels()'s listModels()+RlsService.listTables()
    // Introspection is unnecessary here. The map is keyed by canonical model
    // name; the realtime delivery service passes model.model and setRespectRls stores under model.model, so a direct
    // lookup is correct. Default-on: only an explicit `false` disables filtering.
    const map = await this.getRespectRlsMap();
    return { respectRls: map[modelName] !== false };
  }

  async setRespectRls(modelName: string, respectRls: boolean): Promise<void> {
    const availableModels = await this.getAvailableModels();
    const model = availableModels.find(item => item.model === modelName || item.dbName === modelName);
    if (!model) return; // unknown model: ignore, mirrors sanitizeModels' silent-drop behavior

    const map = await this.getRespectRlsMap();
    const updated = { ...map, [model.model]: respectRls };
    await this.di.prisma.appSetting.upsert({
      where: { key: REALTIME_RESPECT_RLS_KEY },
      update: { value: updated },
      create: { key: REALTIME_RESPECT_RLS_KEY, value: updated },
    });
  }

  private async getRespectRlsMap(): Promise<Record<string, boolean>> {
    const setting = await this.di.prisma.appSetting.findUnique({ where: { key: REALTIME_RESPECT_RLS_KEY } });
    if (!setting || typeof setting.value !== 'object' || setting.value === null || Array.isArray(setting.value)) return {};
    return setting.value as Record<string, boolean>;
  }

  private async getAvailableModels(): Promise<RealtimeModelInfo[]> {
    const models = await this.di.RestApiService.listModels();
    const filtered = models.filter((model: any) => !model.system && !isRestBlockedModel(model.model));

    const rlsByTable = await this.getRlsStateByTable();

    return filtered.map((model: any) => {
      const dbName = String(model.dbName ?? model.model);
      const rlsInfo = rlsByTable?.get(model.model) ?? rlsByTable?.get(dbName);
      return {
        model: String(model.model),
        dbName,
        dynamic: Boolean(model.dynamic),
        riskLevel: this.deriveRiskLevel(rlsInfo),
      };
    });
  }

  private deriveRiskLevel(rlsInfo: { rlsEnabled: boolean; policies: unknown[] } | undefined): RealtimeModelInfo['riskLevel'] {
    if (!rlsInfo) return 'none';
    if (!rlsInfo.rlsEnabled) return 'public';
    return rlsInfo.policies.length > 0 ? 'restricted' : 'private';
  }

  private async getRlsStateByTable(): Promise<Map<string, { rlsEnabled: boolean; policies: unknown[] }> | null> {
    try {
      const rlsService = this.di.RlsService;
      if (!rlsService?.listTables) return null;
      // Call as a method so `this` stays bound: listTables() reads this.di.prisma.
      const tables = await rlsService.listTables();
      const map = new Map<string, { rlsEnabled: boolean; policies: unknown[] }>();
      for (const t of tables) map.set(t.table, { rlsEnabled: t.rlsEnabled, policies: t.policies });
      return map;
    } catch {
      return null;
    }
  }

  private async getConfiguredModels(): Promise<string[] | null> {
    const setting = await this.di.prisma.appSetting.findUnique({ where: { key: REALTIME_MODELS_KEY } });
    if (!setting) return null;
    if (!Array.isArray(setting.value)) return [];
    return setting.value.map(model => String(model)).filter(Boolean);
  }

  private sanitizeModels(models: string[], availableModels: RealtimeModelInfo[]): string[] {
    const byName = new Map<string, string>();
    for (const model of availableModels) {
      byName.set(model.model, model.model);
      byName.set(model.dbName, model.model);
    }

    const seen = new Set<string>();
    const sanitized: string[] = [];
    for (const raw of models) {
      const model = byName.get(String(raw));
      if (!model || seen.has(model)) continue;
      seen.add(model);
      sanitized.push(model);
    }
    return sanitized;
  }
}
