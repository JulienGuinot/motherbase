import type { RealtimePostgresChangeConfig, RealtimeTopicEnvelope } from "@motherbase/contracts";

export type RealtimeStatus =
    | 'idle'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'polling'
    | 'disconnected'
    | 'error';
export type RealtimeStatusListener = (status: RealtimeStatus, detail?: unknown) => void;

export interface RealtimeConnectOptions {
    timeoutMs?: number;
    fallbackPolling?: boolean;
}

export interface RealtimeWatchOptions {
    intervalMs?: number;
    query?: string;
    polling?: boolean;
}

/** Events received are pre-filtered by server-side REST policies for the current session. */
export type RealtimeWatchEvent<T> =
    | { type: 'created' | 'updated' | 'deleted'; source: 'socket'; payload: T }
    | { type: 'snapshot'; source: 'polling'; rows: T[] };

/** Minimal shape we rely on from socket.io-client's Socket. */
export interface SocketLike {
    on(event: string, cb: (...args: unknown[]) => void): void;
    off(event: string, cb?: (...args: unknown[]) => void): void;
    emit(event: string, ...args: unknown[]): void;
    disconnect(): void;
    connected: boolean;
}

export type IoFactory = (url: string, opts: Record<string, unknown>) => SocketLike;

export interface Poller {
    timer: ReturnType<typeof setInterval>;
    stop: () => void;
}

/** What RealtimeModule needs from a RealtimeChannel (avoids a circular import). */
export interface ChannelHandle {
    _receive(envelope: RealtimeTopicEnvelope): void;
    /** Called after a reconnect replayed (or failed to replay) this topic's join. */
    _rejoined?(ok: boolean): void;
}


/** Which table changes to receive. `filter` is a PostgREST-style column filter, e.g. `room_id=eq.42`. */
export type PostgresChangeFilter = RealtimePostgresChangeConfig;

export type PostgresChangeEvent = PostgresChangeFilter['event'];

export interface PostgresChangePayload<T = Record<string, unknown>> {
    schema: string;
    table: string;
    eventType: 'INSERT' | 'UPDATE' | 'DELETE';
    new: T | Record<string, never>;
    old: T | Record<string, never>;
    commit_timestamp: string;
}

export interface BroadcastFilter {
    event: string;
}

export interface PresenceFilter {
    event: 'sync' | 'join' | 'leave';
}

export interface BroadcastMessage {
    type: 'broadcast';
    event: string;
    payload?: Record<string, unknown>;
}

export interface BroadcastReceived {
    type: 'broadcast';
    event: string;
    payload: unknown;
}

/**
 * One tracked presence: whatever the peer passed to `track()`, plus the ref the
 * server stamps on it. Generic so a caller that knows its own payload gets it
 * typed (`channel.presenceState<{ name: string }>()`); the default stays open
 * because presence payloads are defined by the application, not by the SDK.
 */
export type PresenceEntry<T extends Record<string, unknown> = Record<string, unknown>> = T & {
    presence_ref: string;
};
export type PresenceState<T extends Record<string, unknown> = Record<string, unknown>> = Record<
    string,
    PresenceEntry<T>[]
>;
export interface PresenceJoinPayload<T extends Record<string, unknown> = Record<string, unknown>> {
    key: string;
    newPresences: PresenceEntry<T>[];
    currentPresences: PresenceEntry<T>[];
}
export interface PresenceLeavePayload<T extends Record<string, unknown> = Record<string, unknown>> {
    key: string;
    leftPresences: PresenceEntry<T>[];
    currentPresences: PresenceEntry<T>[];
}

export type ChannelStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR';

export interface RealtimeChannelOptions {
    config?: {
        broadcast?: { self?: boolean; ack?: boolean };
        presence?: { key?: string };
        /**
         * Join the private channel of this topic (Realtime Authorization). The
         * server checks the RLS policies on `realtime.messages` at join time:
         * SELECT to receive, INSERT to send or track. Without a readable policy the
         * subscribe ends in CHANNEL_ERROR ("Unauthorized: ...").
         */
        private?: boolean;
    };
}

export interface PgBinding {
    filter: PostgresChangeFilter;
    callback: (payload: PostgresChangePayload) => void;
}


export interface BroadcastBinding {
    event: string;
    callback: (payload: BroadcastReceived) => void;
}
export interface PresenceBinding {
    event: 'sync' | 'join' | 'leave';
    callback: (payload: unknown) => void;
}
