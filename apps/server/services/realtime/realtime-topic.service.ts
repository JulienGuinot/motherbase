import {
  isValidRealtimeTopic,
  realtimeTopicRoom,
  REALTIME_TOPIC_EVENTS,
  type RealtimeJoinAck,
  type RealtimeJoinConfig,
} from '@motherbase/contracts';
import type { Socket } from 'socket.io';
import BaseContext from '../../context/base-context';
import { canJoin, type ChannelAccess, type RealtimeExtension } from './realtime-authorization.service';

type JoinAck = (ack: RealtimeJoinAck) => void;
type LeaveAck = (ack: { status: 'ok' | 'error'; error?: string }) => void;

interface JoinPayload {
  topic?: unknown;
  config?: RealtimeJoinConfig;
}

/**
 * What is kept per joined topic: the client's normalized config, plus, for a
 * private channel, the access its RLS policies granted at join time. `access`
 * is only ever written by the server; `normalizeConfig` drops anything else.
 */
type JoinedTopic = RealtimeJoinConfig & { access?: ChannelAccess };

/** A message delivered from the database by `realtime.send`. */
export interface DatabaseBroadcast {
  topic: string;
  event: string | null;
  payload: unknown;
  private: boolean;
}

/** Per-socket store of joined topics and the config sent at join time. */
function topicStore(socket: Socket): Map<string, JoinedTopic> {
  const data = socket.data as { rtTopics?: Map<string, JoinedTopic> };
  if (!data.rtTopics) data.rtTopics = new Map();
  return data.rtTopics;
}

/** A join config is client-supplied and everything it holds is kept for the
 *  life of the socket, so each part is bounded before it is stored. */
const MAX_PRESENCE_KEY = 128;
const MAX_BINDINGS_PER_TOPIC = 20;
/** Same ceiling as the HTTP broadcast route, so both paths agree. */
export const MAX_EVENT_LENGTH = 255;

function normalizeConfig(config: RealtimeJoinConfig | undefined): RealtimeJoinConfig {
  if (!config || typeof config !== 'object') return {};
  const normalized: RealtimeJoinConfig = {};
  if (config.broadcast) normalized.broadcast = { self: Boolean(config.broadcast.self) };
  if (config.presence) {
    const key = config.presence.key;
    normalized.presence = { key: typeof key === 'string' ? key.slice(0, MAX_PRESENCE_KEY) : undefined };
  }
  if (Array.isArray(config.postgres_changes)) {
    normalized.postgres_changes = config.postgres_changes.slice(0, MAX_BINDINGS_PER_TOPIC);
  }
  if (config.private === true) normalized.private = true;
  return normalized;
}

/** Read-only view of a joined topic's permissions. Public channels allow everything. */
function allows(joined: JoinedTopic | undefined, extension: RealtimeExtension, action: 'read' | 'write'): boolean {
  if (!joined) return false;
  if (!joined.private) return true;
  return Boolean(joined.access?.[extension][action]);
}

export class RealtimeTopicService extends BaseContext {
  // Cached realtime.limits snapshot. The defaults below are permissive, so they
  // are a starting point, never an answer: the first join awaits a real load
  // (see `ensureLimits`), or a subscription made before the settings arrive is
  // decided by limits nobody configured.
  private limits = { enablePostgresChanges: true, maxChannelsPerClient: 100, privateOnly: false };

  /** In-flight or completed first load. Awaited once, refreshed afterwards. */
  private firstLoad: Promise<void> | null = null;

  /** Refresh the cached limits from settings. Public so callers/tests can prime it. */
  async reloadLimits(): Promise<void> {
    try {
      const c = await this.di.SettingsService.get<{
        enablePostgresChanges?: boolean;
        maxChannelsPerClient?: number;
        privateOnly?: boolean;
      }>('realtime.limits');
      this.limits = {
        enablePostgresChanges: c?.enablePostgresChanges !== false,
        maxChannelsPerClient: Number(c?.maxChannelsPerClient) || 100,
        privateOnly: c?.privateOnly === true,
      };
    } catch {
      // Keep the last-known limits when settings storage is unavailable.
    }
  }

  /**
   * Make sure the limits were read at least once before they are enforced.
   *
   * The first caller waits for the settings; every later one refreshes in the
   * background and keeps the hot path synchronous, which is what the cache was
   * for. `reloadLimits` never rejects, so this never leaves a pending first load
   * behind.
   */
  private async ensureLimits(): Promise<void> {
    if (!this.firstLoad) this.firstLoad = this.reloadLimits();
    else void this.reloadLimits();
    await this.firstLoad;
  }

  async join(socket: Socket, payload: JoinPayload, ack?: JoinAck): Promise<void> {
    const respond = typeof ack === 'function' ? ack : undefined;
    const topic = payload?.topic;
    if (!isValidRealtimeTopic(topic)) {
      respond?.({ status: 'error', error: 'Invalid realtime topic.' });
      return;
    }
    await this.ensureLimits();
    const config = normalizeConfig(payload?.config);
    const store = topicStore(socket);
    if (!store.has(topic) && store.size >= this.limits.maxChannelsPerClient) {
      respond?.({ status: 'error', error: 'Channel limit reached for this connection.' });
      return;
    }
    if (!config.private && this.limits.privateOnly) {
      respond?.({ status: 'error', error: 'This project only allows private channels.' });
      return;
    }
    // The slot is taken before the first await: the limit check above and this
    // reservation run in one tick, so concurrent joins cannot all pass the check.
    // A private channel has no `access` yet, which `allows` reads as denied.
    const previous = store.get(topic);
    const joined: JoinedTopic = { ...config };
    store.set(topic, joined);
    const release = () => (previous ? store.set(topic, previous) : store.delete(topic));
    try {
      if (config.private) {
        joined.access = await this.di.RealtimeAuthorizationService.channelAccess(socket.data?.user ?? null, topic);
        if (!canJoin(joined.access)) {
          release();
          respond?.({ status: 'error', error: `Unauthorized: You do not have permissions to read from this Channel topic: ${topic}` });
          return;
        }
      }
      // Re-joining the same topic with the other visibility moves the socket
      // between the two audiences instead of leaving it in both.
      if (previous && Boolean(previous.private) !== Boolean(config.private)) {
        await socket.leave(realtimeTopicRoom(topic, previous.private));
      }
      await socket.join(realtimeTopicRoom(topic, config.private));
    } catch {
      release();
      respond?.({ status: 'error', error: 'Realtime join failed.' });
      return;
    }
    if (config.presence && allows(joined, 'presence', 'read')) {
      this.di.RealtimePresenceService.sendStateTo(socket, topic, Boolean(config.private));
    }
    // postgres_changes are only wired when the feature is enabled.
    const bindings = this.limits.enablePostgresChanges ? (config.postgres_changes ?? []) : [];
    for (const [index, binding] of bindings.entries()) {
      this.di.RealtimePostgresService.register(socket, topic, binding, index + 1);
    }
    respond?.({
      status: 'ok',
      bindingIds: true,
      postgres_changes: bindings.map((_, index) => ({ id: index + 1 })),
    });
  }

  leave(socket: Socket, payload: { topic?: unknown }, ack?: LeaveAck): void {
    const respond = typeof ack === 'function' ? ack : undefined;
    const topic = payload?.topic;
    if (!isValidRealtimeTopic(topic)) {
      respond?.({ status: 'error', error: 'Invalid realtime topic.' });
      return;
    }
    const store = topicStore(socket);
    Promise.resolve(socket.leave(realtimeTopicRoom(topic, store.get(topic)?.private))).then(
      () => {
        store.delete(topic);
        this.di.RealtimePostgresService.unregisterTopic(socket, topic);
        respond?.({ status: 'ok' });
      },
      () => respond?.({ status: 'error', error: 'Realtime leave failed.' })
    );
  }

  /**
   * Relay a client broadcast (`rt:msg` type `broadcast`) to the topic room.
   * The sender receives its own message only if it joined with `broadcast.self`.
   */
  relay(socket: Socket, envelope: unknown, ack?: (result: 'ok' | 'error') => void): void {
    const respond = typeof ack === 'function' ? ack : undefined;
    const env = envelope as { topic?: unknown; type?: unknown; event?: unknown; payload?: unknown };
    if (!isValidRealtimeTopic(env?.topic)) {
      respond?.('error');
      return;
    }
    const config = topicStore(socket).get(env.topic);
    if (!config) {
      // Must have joined the topic before sending to it.
      respond?.('error');
      return;
    }

    if (env.type === 'broadcast') {
      const event = String(env.event ?? '');
      if (event.length > MAX_EVENT_LENGTH) {
        respond?.('error');
        return;
      }
      if (!allows(config, 'broadcast', 'write')) {
        respond?.('error');
        return;
      }
      const out = {
        topic: env.topic,
        type: 'broadcast' as const,
        event,
        payload: env.payload ?? {},
      };
      if (config.private) {
        this.di.SocketService.emitEnvelopeToTopic(env.topic, out, { extension: 'broadcast', exceptSocketId: socket.id });
      } else {
        socket.to(realtimeTopicRoom(env.topic)).emit(REALTIME_TOPIC_EVENTS.message, out);
      }
      if (config.broadcast?.self && allows(config, 'broadcast', 'read')) socket.emit(REALTIME_TOPIC_EVENTS.message, out);
      respond?.('ok');
      return;
    }

    if (env.type === 'presence') {
      const key = config.presence?.key || socket.id;
      const isPrivate = Boolean(config.private);
      if (!allows(config, 'presence', 'write')) {
        respond?.('error');
      } else if (env.event === 'track') {
        const state = (env.payload as { state?: Record<string, unknown> } | undefined)?.state ?? {};
        this.di.RealtimePresenceService.track(socket, env.topic, state, key, isPrivate);
        respond?.('ok');
      } else if (env.event === 'untrack') {
        this.di.RealtimePresenceService.untrack(socket, env.topic, isPrivate);
        respond?.('ok');
      } else {
        respond?.('error');
      }
      return;
    }

    respond?.('error');
  }

  /**
   * Deliver messages sent from SQL with `realtime.send`, claimed from the
   * outbox. A private message reaches only the private channel of its topic,
   * and there only the sockets whose policies let them read broadcast; a
   * public one reaches only the public channel, as on Supabase.
   */
  deliverDatabaseBroadcasts(messages: DatabaseBroadcast[]): void {
    for (const message of messages) {
      if (!isValidRealtimeTopic(message?.topic)) continue;
      const envelope = {
        topic: message.topic,
        type: 'broadcast' as const,
        event: String(message.event ?? ''),
        payload: message.payload ?? {},
      };
      if (message.private) this.di.SocketService.emitEnvelopeToTopic(message.topic, envelope, { extension: 'broadcast' });
      else this.di.SocketService.emitEnvelopeToTopic(message.topic, envelope);
    }
  }

  /** Whether `socket` joined the private channel `topic` with read access to `extension`. */
  canReceivePrivate(socket: Socket, topic: string, extension: RealtimeExtension): boolean {
    const joined = topicStore(socket).get(topic);
    return Boolean(joined?.private) && allows(joined, extension, 'read');
  }

  /** Drop all topic state for a disconnecting socket (rooms are auto-left by socket.io). */
  cleanup(socket: Socket): void {
    this.di.RealtimePostgresService.unregisterSocket(socket);
    topicStore(socket).clear();
  }

  joinedTopics(socket: Socket): string[] {
    return Array.from(topicStore(socket).keys());
  }
}
