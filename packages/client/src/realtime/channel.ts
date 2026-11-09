import type { RealtimeModule } from './index.js';
import type {
  RealtimeJoinConfig,
  RealtimePostgresChangeConfig,
  RealtimeTopicEnvelope,
} from '@motherbase/contracts';
import { BroadcastBinding, BroadcastFilter, BroadcastMessage, BroadcastReceived, ChannelStatus, PgBinding, PostgresChangeFilter, PostgresChangePayload, PresenceBinding, PresenceEntry, PresenceFilter, PresenceJoinPayload, PresenceLeavePayload, PresenceState, RealtimeChannelOptions } from './types.js';


/**
 * Supabase-compatible realtime channel. Multiplexes broadcast, presence, and
 * postgres_changes over a single topic. `postgres_changes` is delivered through
 * the RealtimeModule.watchTable bridge in this release; broadcast/presence are
 * routed by topic via rt:msg envelopes.
 */
export class RealtimeChannel {
  private readonly pgBindings: PgBinding[] = [];
  private readonly broadcastBindings: BroadcastBinding[] = [];
  private readonly presenceBindings: PresenceBinding[] = [];
  private status: ChannelStatus = 'CLOSED';
  private presence: Record<string, PresenceEntry[]> = {};
  /** Settles when the current subscribe() attempt has an ack (or has failed). */
  private ready: Promise<void> = Promise.resolve();
  private onStatus?: (status: ChannelStatus, err?: Error) => void;
  /** Last state passed to track(), replayed after a reconnect. */
  private trackedState: Record<string, unknown> | null = null;
  private generation = 0;
  private subscribing = false;

  constructor(
    readonly topic: string,
    private readonly realtime: RealtimeModule,
    private readonly options: RealtimeChannelOptions = {},
  ) { }

  /**
   * Listen on this channel. Call before `subscribe()`.
   *
   * - `'broadcast'`: messages other clients `send()` with this `event`.
   * - `'presence'`: who is online (`sync`, `join`, `leave`).
   * - `'postgres_changes'`: inserts, updates and deletes on a table.
   *
   * @example
   * client.channel('room:1')
   *   .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, p => console.log(p.new))
   *   .subscribe()
   */
  on(type: 'broadcast', filter: BroadcastFilter, callback: (payload: BroadcastReceived) => void): this;
  // One overload per presence event, so the callback gets the payload that event
  // delivers. The wide form stays last for a filter whose event is not a literal.
  on(type: 'presence', filter: { event: 'sync' }, callback: () => void): this;
  on<T extends Record<string, unknown> = Record<string, unknown>>(
    type: 'presence', filter: { event: 'join' }, callback: (payload: PresenceJoinPayload<T>) => void,
  ): this;
  on<T extends Record<string, unknown> = Record<string, unknown>>(
    type: 'presence', filter: { event: 'leave' }, callback: (payload: PresenceLeavePayload<T>) => void,
  ): this;
  on(type: 'presence', filter: PresenceFilter, callback: (payload: unknown) => void): this;
  on(type: 'postgres_changes', filter: PostgresChangeFilter, callback: (payload: PostgresChangePayload) => void): this;
  on(
    type: string,
    filter: BroadcastFilter | PresenceFilter | PostgresChangeFilter,
    callback: (payload: never) => void,
  ): this {
    if (type === 'broadcast') {
      this.broadcastBindings.push({
        event: (filter as BroadcastFilter).event,
        callback: callback as (p: BroadcastReceived) => void,
      });
    } else if (type === 'presence') {
      this.presenceBindings.push({
        event: (filter as PresenceFilter).event,
        callback: callback as (p: unknown) => void,
      });
    } else if (type === 'postgres_changes') {
      this.pgBindings.push({
        filter: filter as PostgresChangeFilter,
        callback: callback as (p: PostgresChangePayload) => void,
      });
    } else {
      throw new Error(`Unsupported channel event type "${type}". Use broadcast | presence | postgres_changes.`);
    }
    return this;
  }

  /**
   * Join the topic. Returns `this` (supabase-js shape), so it is NOT awaitable:
   * `send()` / `track()` / `untrack()` issued straight after are queued until the
   * join is acked instead of leaving early and being rejected by the server.
   */
  subscribe(onStatus?: (status: ChannelStatus, err?: Error) => void, timeoutMs = 10_000): this {
    this.onStatus = onStatus;
    if (this.subscribing || this.status === 'SUBSCRIBED') return this;
    const generation = ++this.generation;
    this.subscribing = true;
    this.ready = (async () => {
      try {
        await this.realtime.connect({ fallbackPolling: false });
      } catch (err) {
        if (generation !== this.generation) return;
        this.subscribing = false;
        this.setStatus('CHANNEL_ERROR', err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (generation !== this.generation) return;
      this.realtime.registerChannel(this.topic, this);
      const ack = await this.realtime.joinTopic(this.topic, this.buildConfig(), timeoutMs);
      if (generation !== this.generation) return;
      this.subscribing = false;
      if (ack.status === 'ok' && this.pgBindings.length > 1 && !ack.bindingIds) {
        this.realtime.leaveTopic(this.topic);
        this.realtime.unregisterChannel(this.topic);
        this.setStatus('CHANNEL_ERROR', new Error('Multiple postgres_changes bindings require a server with binding-id support. Upgrade the server or use one binding per channel.'));
        return;
      }
      if (ack.status === 'ok') this.setStatus('SUBSCRIBED');
      else if (ack.error === 'timeout') this.setStatus('TIMED_OUT', new Error('Realtime join timed out'));
      else this.setStatus('CHANNEL_ERROR', new Error(ack.error ?? 'Realtime join failed'));
    })();
    return this;
  }

  /** Leave the topic and stop every listener. The channel can `subscribe()` again. */
  async unsubscribe(): Promise<'ok'> {
    this.generation += 1;
    this.subscribing = false;
    this.realtime.leaveTopic(this.topic);
    this.realtime.unregisterChannel(this.topic);
    this.presence = {};
    this.trackedState = null;
    this.setStatus('CLOSED');
    this.ready = Promise.resolve();
    return 'ok';
  }

  /**
   * Broadcast a message to the topic. Other clients on the topic with a matching
   * `on('broadcast', { event })` binding receive it; the sender receives its own
   * message only when the channel was created with `config.broadcast.self`.
   * With `config.broadcast.ack`, resolves on the server ack.
   */
  async send(message: BroadcastMessage): Promise<'ok' | 'timed out' | 'error'> {
    if (!(await this.subscribed())) return 'error';
    if (this.options.config?.broadcast?.ack) {
      return this.realtime.sendTopicWithAck(this.topic, 'broadcast', message.event, message.payload ?? {});
    }
    this.realtime.sendTopic(this.topic, 'broadcast', message.event, message.payload ?? {});
    return 'ok';
  }

  /** Announce this client's presence on the topic with the given state. */
  async track(state: Record<string, unknown>): Promise<'ok' | 'timed out' | 'error'> {
    this.trackedState = state;
    if (!(await this.subscribed())) return 'error';
    return this.realtime.sendTopicWithAck(this.topic, 'presence', 'track', { state });
  }

  /** Remove this client's presence from the topic. */
  async untrack(): Promise<'ok' | 'timed out' | 'error'> {
    this.trackedState = null;
    if (!(await this.subscribed())) return 'error';
    return this.realtime.sendTopicWithAck(this.topic, 'presence', 'untrack', {});
  }

  /** Current presence state, keyed by presence key. */
  presenceState<T extends Record<string, unknown> = Record<string, unknown>>(): PresenceState<T> {
    return this.presence as PresenceState<T>;
  }

  /** Wait for a pending subscribe() to settle; false when the topic is not joined. */
  private async subscribed(): Promise<boolean> {
    await this.ready;
    return this.status === 'SUBSCRIBED';
  }

  private setStatus(status: ChannelStatus, err?: Error): void {
    this.status = status;
    this.onStatus?.(status, err);
  }

  /** Internal: the module replayed this topic's join on a new socket. */
  _rejoined(ok: boolean): void {
    if (!ok) {
      this.setStatus('CHANNEL_ERROR', new Error('Realtime rejoin failed'));
      return;
    }
    // Presence lives on the server socket that just died: re-announce it.
    if (this.trackedState) {
      void this.realtime.sendTopicWithAck(this.topic, 'presence', 'track', { state: this.trackedState });
    }
    this.setStatus('SUBSCRIBED');
  }

  /** Internal: receive a topic envelope routed by RealtimeModule. */
  _receive(envelope: RealtimeTopicEnvelope): void {
    if (envelope.type === 'broadcast') {
      for (const binding of this.broadcastBindings) {
        if (binding.event === '*' || binding.event === envelope.event) {
          binding.callback({ type: 'broadcast', event: envelope.event, payload: envelope.payload });
        }
      }
    } else if (envelope.type === 'presence') {
      // The server sends the full presence state; diff it into sync/join/leave.
      if (envelope.event === 'state') this.applyPresenceState(envelope.payload as Record<string, PresenceEntry[]>);
    } else if (envelope.type === 'postgres_changes') {
      const payload = envelope.payload as PostgresChangePayload;
      for (const [index, binding] of this.pgBindings.entries()) {
        if (envelope.bindingId !== undefined ? envelope.bindingId !== index + 1 : this.pgBindings.length > 1) continue;
        const filter = binding.filter;
        if ((filter.schema ?? 'public') !== payload.schema) continue;
        if (filter.table !== payload.table) continue;
        if (filter.event !== '*' && filter.event !== payload.eventType) continue;
        binding.callback(payload);
      }
    }
  }

  private applyPresenceState(next: Record<string, PresenceEntry[]>): void {
    const prev = this.presence;
    const prevRefs = new Set<string>();
    for (const key of Object.keys(prev)) for (const p of prev[key]) prevRefs.add(p.presence_ref);
    const nextRefs = new Set<string>();
    for (const key of Object.keys(next)) for (const p of next[key]) nextRefs.add(p.presence_ref);

    for (const key of Object.keys(next)) {
      const newPresences = next[key].filter(p => !prevRefs.has(p.presence_ref));
      if (newPresences.length) {
        this.emitPresence('join', { key, newPresences, currentPresences: next[key] });
      }
    }
    for (const key of Object.keys(prev)) {
      const leftPresences = prev[key].filter(p => !nextRefs.has(p.presence_ref));
      if (leftPresences.length) {
        this.emitPresence('leave', { key, leftPresences, currentPresences: next[key] ?? [] });
      }
    }
    this.presence = next;
    this.emitPresence('sync', undefined);
  }

  private emitPresence(event: 'sync' | 'join' | 'leave', payload: unknown): void {
    for (const binding of this.presenceBindings) {
      if (binding.event === event) binding.callback(payload);
    }
  }

  private buildConfig(): RealtimeJoinConfig {
    const config: RealtimeJoinConfig = {};
    if (this.options.config?.broadcast) {
      config.broadcast = { self: Boolean(this.options.config.broadcast.self) };
    }
    if (this.options.config?.presence) {
      config.presence = { key: this.options.config.presence.key };
    }
    if (this.options.config?.private) config.private = true;
    if (this.pgBindings.length) {
      config.postgres_changes = this.pgBindings.map<RealtimePostgresChangeConfig>(b => ({
        event: b.filter.event,
        schema: b.filter.schema ?? 'public',
        table: b.filter.table,
        filter: b.filter.filter,
      }));
    }
    return config;
  }
}
