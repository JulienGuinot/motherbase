import { RealtimeJoinConfig, normalizeRealtimeModel, contractPath, RealtimeJoinAck, REALTIME_TOPIC_EVENTS, RealtimeTopicMessageType, RealtimeTopicEnvelope, REALTIME_SOCKET_EVENTS } from '@motherbase/contracts';
import { IoFactory, ChannelHandle, RealtimeStatus, RealtimeStatusListener, RealtimeConnectOptions, RealtimeWatchEvent, RealtimeWatchOptions, SocketLike, Poller } from './types.js';
import { SessionStore } from '../auth/session.js';

/**
 * Lazy wrapper over socket.io-client. The dependency is optional: it is only
 * imported when `connect()` is called, so apps that never use realtime do not
 * need to install it.
 */
export class RealtimeModule {
    private socket: SocketLike | null = null;
    private status: RealtimeStatus = 'idle';
    private readonly statusListeners = new Set<RealtimeStatusListener>();
    private readonly pollers = new Map<number, Poller>();
    private readonly tableSubscriptionRefs = new Map<string, number>();
    private pollerSeq = 0;
    private readonly channelsByTopic = new Map<string, ChannelHandle>();
    /** Topics joined on the current socket, replayed as-is after a reconnect. */
    private readonly joinedTopics = new Map<string, RealtimeJoinConfig>();
    private topicRouterBound = false;
    private connecting: Promise<void> | null = null;
    private readonly pendingJoins = new Map<string, symbol>();
    /** The token the open socket authenticated with: undefined = anonymous. */
    private handshakeToken: string | undefined;

    constructor(
        private readonly baseUrl: string,
        private readonly store: SessionStore,
        private readonly fetchImpl: typeof fetch = globalThis.fetch?.bind(globalThis),
        /** Inject a socket factory (tests / custom transports). Falls back to socket.io-client. */
        private readonly ioFactory?: IoFactory
    ) {
        // The server reads the session once, in the handshake. A socket opened
        // signed out would otherwise stay anonymous after a sign-in (and RLS then
        // filters every row out of its channels), and one opened signed in would
        // keep the old user after a sign-out. supabase-js re-auths its socket on
        // these events too.
        this.store.subscribe(() => {
            if (this.socket && this.store.get()?.accessToken !== this.handshakeToken) void this.reauthenticate();
        });
    }

    /**
     * Reopen the socket under the current session. Joined topics are kept, so
     * the `connect` handler replays them on the new socket and each channel
     * reports SUBSCRIBED (or CHANNEL_ERROR) again through its status callback.
     */
    private async reauthenticate(): Promise<void> {
        const previous = this.socket;
        if (!previous) return;
        previous.disconnect();
        if (this.socket !== previous) return;
        this.socket = null;
        this.topicRouterBound = false;
        try {
            await this.connect();
        } catch {
            // connect() has already reported the failure through the status listeners.
        }
    }

    /** True once a socket is connected. */
    get connected(): boolean {
        return Boolean(this.socket?.connected);
    }

    /** The connection state right now. */
    getStatus(): RealtimeStatus {
        return this.status;
    }

    /** Call `listener` now and on every connection state change. Returns the unsubscribe function. */
    onStatusChange(listener: RealtimeStatusListener): () => void {
        this.statusListeners.add(listener);
        listener(this.status);
        return () => this.statusListeners.delete(listener);
    }

    /** Concurrent callers (several channels subscribing at once) share one attempt, not one socket each. */
    connect(options: RealtimeConnectOptions = {}): Promise<void> {
        if (this.socket?.connected) return Promise.resolve();
        this.connecting ??= this.open(options).finally(() => {
            this.connecting = null;
        });
        return this.connecting;
    }

    private async open(options: RealtimeConnectOptions): Promise<void> {
        this.setStatus('connecting');

        let io: IoFactory;
        if (this.ioFactory) {
            io = this.ioFactory;
        } else {
            try {
                // socket.io-client is an optional peer dependency; resolved at runtime only.
                // ts-ignore rather than ts-expect-error: whether its types resolve depends
                // on whether a sibling workspace installed it (apps/server does, for its
                // realtime integration test), and an unused expect-error fails the build.
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-ignore -- optional peer dependency resolved only when realtime connects
                ({ io } = (await import('socket.io-client')) as unknown as { io: IoFactory });
            } catch {
                if (options.fallbackPolling) {
                    this.setStatus('polling');
                    return;
                }
                this.setStatus('error', 'socket.io-client is not installed');
                throw new Error(
                    'Realtime requires the optional dependency "socket.io-client". Install it: npm i socket.io-client'
                );
            }
        }

        // The session may not be in memory yet (http.ts hydrates before every
        // request; nothing hydrates before a channel subscribe). Without this the
        // socket connects anonymously on a cold page load.
        await this.store.hydrate();
        // What the handshake is about to send; the auth callback below keeps it
        // current across socket.io's own reconnects.
        this.handshakeToken = this.store.get()?.accessToken;
        const socket = io(this.baseUrl, {
            path: '/ws',
            transports: ['websocket'],
            reconnection: true,
            // Read as a callback, not a snapshot: socket.io replays the auth payload
            // on every reconnect, so a fixed object would pin the socket to whatever
            // token existed at connect() time (or to none) for the whole session.
            auth: (cb: (data: Record<string, unknown>) => void) => {
                const token = this.store.get()?.accessToken;
                this.handshakeToken = token;
                cb(token ? { token } : {});
            },
        });
        this.socket = socket;
        this.bindSocketStatus(socket);
        this.topicRouterBound = false;
        this.bindTopicRouter();

        try {
            await this.waitForConnect(socket, options.timeoutMs ?? 5000, Boolean(options.fallbackPolling));
        } catch (error) {
            // A failed attempt must not leave a socket retrying in the background.
            socket.disconnect();
            if (this.socket === socket) this.socket = null;
            throw error;
        }
    }

    on(event: string, cb: (...args: unknown[]) => void): void {
        this.socket?.on(event, cb);
    }

    off(event: string, cb?: (...args: unknown[]) => void): void {
        this.socket?.off(event, cb);
    }

    emit(event: string, ...args: unknown[]): void {
        this.socket?.emit(event, ...args);
    }

    /**
     * @deprecated Legacy low-level table watcher. Prefer the Supabase-shaped
     * `client.channel(topic).on('postgres_changes', { event, schema, table, filter }, cb)`.
     * Kept for backwards compatibility; scheduled for removal.
     *
     * Subscribe to create/update/delete events for a model table.
     *
     * Events are filtered server-side: you will only receive events for rows
     * your session is authorized to see (based on REST API SELECT policies).
     * Anonymous sessions receive only public rows; authenticated sessions receive
     * rows matching their access policies (e.g. owner-only rows they own).
     *
     * Falls back to polling the REST endpoint at subscribe time if the WebSocket
     * is not yet connected (polling does not auto-start on later disconnects).
     */
    watchTable<T>(
        model: string,
        cb: (event: RealtimeWatchEvent<T>) => void,
        options: RealtimeWatchOptions = {}
    ): () => void {
        const normalizedModel = normalizeRealtimeModel(model);
        if (!normalizedModel) throw new Error('Invalid realtime model: ' + model);

        const handlers: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];
        const baseEvent = normalizedModel;
        for (const type of ['created', 'updated', 'deleted'] as const) {
            const event = contractPath.realtime(baseEvent, type);
            const handler = (payload: unknown) => cb({ type, source: 'socket', payload: payload as T });
            handlers.push({ event, handler });
            this.socket?.on(event, handler);
        }
        this.retainTableSubscription(normalizedModel);

        const shouldPoll = options.polling !== false && (!this.socket?.connected || this.status === 'polling');
        const pollerId = shouldPoll ? this.startPolling(model, cb, options) : null;

        return () => {
            for (const item of handlers) this.socket?.off(item.event, item.handler);
            this.releaseTableSubscription(normalizedModel);
            if (pollerId !== null) this.stopPolling(pollerId);
        };
    }

    /** Close the socket and stop every poller. */
    disconnect(): void {
        this.pendingJoins.clear();
        for (const id of Array.from(this.pollers.keys())) this.stopPolling(id);
        this.socket?.disconnect();
        this.socket = null;
        this.topicRouterBound = false;
        this.setStatus('disconnected');
    }

    /** Register a channel so incoming rt:msg envelopes for its topic are routed to it. */
    registerChannel(topic: string, channel: ChannelHandle): void {
        this.channelsByTopic.set(topic, channel);
        this.bindTopicRouter();
    }

    unregisterChannel(topic: string): void {
        this.pendingJoins.delete(topic);
        this.channelsByTopic.delete(topic);
        // Drop the rejoin memo too, or removeChannel()/removeAllChannels() would
        // resurrect the topic on the next reconnect.
        this.joinedTopics.delete(topic);
    }

    /** Emit rt:join and resolve the server ack (or a timeout/error ack). */
    joinTopic(topic: string, config: RealtimeJoinConfig, timeoutMs = 10_000): Promise<RealtimeJoinAck> {
        if (!this.socket?.connected) return Promise.resolve({ status: 'error', error: 'not-connected' });
        const socket = this.socket;
        const attempt = Symbol(topic);
        this.pendingJoins.set(topic, attempt);
        return new Promise<RealtimeJoinAck>(resolve => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                if (this.pendingJoins.get(topic) === attempt) this.leaveTopic(topic);
                resolve({ status: 'error', error: 'timeout' });
            }, timeoutMs);
            socket.emit(REALTIME_TOPIC_EVENTS.join, { topic, config }, (ack: RealtimeJoinAck) => {
                // The server's join can itself be asynchronous. A leave sent while
                // it was authorizing may arrive too early, so clean up its late ack
                // unless a newer subscription now owns this topic.
                const cleanupCancelledJoin = () => {
                    if (ack?.status === 'ok' && this.socket === socket
                        && !this.pendingJoins.has(topic) && !this.joinedTopics.has(topic)) {
                        socket.emit(REALTIME_TOPIC_EVENTS.leave, { topic });
                    }
                };
                if (settled) {
                    cleanupCancelledJoin();
                    return;
                }
                settled = true;
                clearTimeout(timer);
                if (this.pendingJoins.get(topic) !== attempt || this.socket !== socket) {
                    cleanupCancelledJoin();
                    resolve({ status: 'error', error: 'cancelled' });
                    return;
                }
                this.pendingJoins.delete(topic);
                const result = ack ?? { status: 'error' as const, error: 'no-ack' };
                // Server-side topic state (rtTopics, postgres_changes bindings, presence)
                // dies with the socket, so remember what to replay after a reconnect.
                if (result.status === 'ok') this.joinedTopics.set(topic, config);
                resolve(result);
            });
        });
    }

    leaveTopic(topic: string): void {
        this.pendingJoins.delete(topic);
        this.joinedTopics.delete(topic);
        this.socket?.emit(REALTIME_TOPIC_EVENTS.leave, { topic });
    }

    sendTopic(topic: string, type: RealtimeTopicMessageType, event: string, payload: unknown): void {
        this.socket?.emit(REALTIME_TOPIC_EVENTS.message, { topic, type, event, payload });
    }

    /** Emit an rt:msg and wait for the server ack (or resolve 'timed out'/'error'). */
    sendTopicWithAck(
        topic: string,
        type: RealtimeTopicMessageType,
        event: string,
        payload: unknown,
        timeoutMs = 10_000
    ): Promise<'ok' | 'timed out' | 'error'> {
        if (!this.socket?.connected) return Promise.resolve('error');
        const socket = this.socket;
        return new Promise(resolve => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                resolve('timed out');
            }, timeoutMs);
            socket.emit(REALTIME_TOPIC_EVENTS.message, { topic, type, event, payload }, (result: 'ok' | 'error') => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(result === 'ok' ? 'ok' : 'error');
            });
        });
    }

    private bindTopicRouter(): void {
        if (this.topicRouterBound || !this.socket) return;
        this.topicRouterBound = true;
        this.socket.on(REALTIME_TOPIC_EVENTS.message, (env: unknown) => {
            const envelope = env as RealtimeTopicEnvelope;
            if (!envelope || typeof envelope.topic !== 'string') return;
            this.channelsByTopic.get(envelope.topic)?._receive(envelope);
        });
    }

    private retainTableSubscription(model: string): void {
        const refs = this.tableSubscriptionRefs.get(model) ?? 0;
        this.tableSubscriptionRefs.set(model, refs + 1);
        if (refs === 0 && this.socket?.connected) this.socket.emit(REALTIME_SOCKET_EVENTS.subscribe, model);
    }

    private releaseTableSubscription(model: string): void {
        const refs = this.tableSubscriptionRefs.get(model) ?? 0;
        if (refs > 1) {
            this.tableSubscriptionRefs.set(model, refs - 1);
            return;
        }
        this.tableSubscriptionRefs.delete(model);
        if (refs === 1 && this.socket?.connected) this.socket.emit(REALTIME_SOCKET_EVENTS.unsubscribe, model);
    }

    private resubscribeTables(): void {
        if (!this.socket?.connected) return;
        for (const model of this.tableSubscriptionRefs.keys()) {
            this.socket.emit(REALTIME_SOCKET_EVENTS.subscribe, model);
        }
    }

    /**
     * Replay every joined topic on a fresh socket. The server keeps topic state on
     * the socket, so without this a reconnected channel still reports SUBSCRIBED
     * and receives nothing at all.
     */
    private async rejoinTopics(): Promise<void> {
        for (const [topic, config] of Array.from(this.joinedTopics)) {
            const ack = await this.joinTopic(topic, config);
            this.channelsByTopic.get(topic)?._rejoined?.(ack.status === 'ok');
        }
    }

    private bindSocketStatus(socket: SocketLike): void {
        socket.on('connect', () => {
            this.setStatus('connected');
            this.resubscribeTables();
            void this.rejoinTopics();
        });
        socket.on('disconnect', () => this.setStatus(this.pollers.size ? 'polling' : 'disconnected'));
        socket.on('connect_error', error => this.setStatus('error', error));
        socket.on('reconnect_attempt', () => this.setStatus('reconnecting'));
        socket.on('reconnect', () => this.setStatus('connected'));
    }

    private waitForConnect(socket: SocketLike, timeoutMs: number, fallbackPolling: boolean): Promise<void> {
        if (socket.connected) {
            this.setStatus('connected');
            this.resubscribeTables();
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                socket.off('connect', onConnect);
                socket.off('connect_error', onError);
                clearTimeout(timer);
            };
            const settle = (fn: () => void) => {
                if (settled) return;
                settled = true;
                cleanup();
                fn();
            };
            const onConnect = () =>
                settle(() => {
                    this.setStatus('connected');
                    resolve();
                });
            const onError = (error: unknown) => {
                if (fallbackPolling) {
                    settle(() => {
                        this.setStatus('polling', error);
                        resolve();
                    });
                    return;
                }
                settle(() => {
                    this.setStatus('error', error);
                    reject(error instanceof Error ? error : new Error(String(error)));
                });
            };
            const timer = setTimeout(() => {
                if (fallbackPolling) {
                    settle(() => {
                        this.setStatus('polling');
                        resolve();
                    });
                    return;
                }
                settle(() => {
                    const error = new Error('Realtime connection timeout');
                    this.setStatus('error', error);
                    reject(error);
                });
            }, timeoutMs);

            socket.on('connect', onConnect);
            socket.on('connect_error', onError);
        });
    }

    private startPolling<T>(
        model: string,
        cb: (event: RealtimeWatchEvent<T>) => void,
        options: RealtimeWatchOptions
    ): number {
        if (!this.fetchImpl) throw new Error('Realtime polling requires a fetch implementation.');
        const id = ++this.pollerSeq;
        let last = '';
        let stopped = false;
        const run = async () => {
            if (stopped) return;
            const rows = await this.fetchRows<T>(model, options.query);
            const snapshot = JSON.stringify(rows);
            if (snapshot !== last) {
                last = snapshot;
                cb({ type: 'snapshot', source: 'polling', rows });
            }
        };
        const timer = setInterval(() => {
            run().catch(error => this.setStatus('error', error));
        }, options.intervalMs ?? 5000);
        this.pollers.set(id, {
            timer,
            stop: () => {
                stopped = true;
                clearInterval(timer);
            },
        });
        this.setStatus(this.socket?.connected ? 'connected' : 'polling');
        run().catch(error => this.setStatus('error', error));
        return id;
    }

    private stopPolling(id: number): void {
        const poller = this.pollers.get(id);
        if (!poller) return;
        poller.stop();
        this.pollers.delete(id);
        if (!this.socket?.connected && this.pollers.size === 0) this.setStatus('disconnected');
    }

    private async fetchRows<T>(model: string, query?: string): Promise<T[]> {
        const path = `${contractPath.rest(model)}${query ? (query.startsWith('?') ? query : `?${query}`) : ''}`;
        const headers: Record<string, string> = {};
        const token = this.store.get()?.accessToken;
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers });
        if (!res.ok) throw new Error(`Realtime polling failed with ${res.status}`);
        return (await res.json()) as T[];
    }

    private setStatus(status: RealtimeStatus, detail?: unknown): void {
        this.status = status;
        for (const listener of this.statusListeners) listener(status, detail);
    }
}
