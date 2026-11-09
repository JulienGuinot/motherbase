import {
  normalizeRealtimeModel,
  realtimeTopicRoom,
  REALTIME_SOCKET_EVENTS,
  REALTIME_TOPIC_EVENTS,
} from '@motherbase/contracts';
import type { Server, Socket } from 'socket.io';
import BaseContext from '../context/base-context';
import { logActivity } from '../lib/activity-log';
import type { RealtimeExtension } from './realtime/realtime-authorization.service';

export interface RealtimeSocketUser {
  id: string;
  role: string;
}

export interface SubscriberIdentityGroup {
  key: string;
  user: RealtimeSocketUser | null;
  socketIds: string[];
}

/**
 * Who in a topic receives an envelope. Absent: the public channel, everyone.
 * Present: the private channel, only the members whose policies let them read
 * `extension`, minus the sender when it asked not to hear itself.
 */
export interface PrivateTopicAudience {
  extension: RealtimeExtension;
  exceptSocketId?: string;
}

type SubscriptionAck = (result: { ok: true; model: string } | { ok: false; error: string }) => void;

const ROOM_PREFIX = 'realtime:model:';

export function realtimeModelRoom(model: string): string | null {
  const normalized = normalizeRealtimeModel(model);
  return normalized ? `${ROOM_PREFIX}${normalized}` : null;
}

export class SocketService extends BaseContext {
  private initialized = false;
  private io: Server | null = null;

  initialize(io: Server): void {
    if (this.initialized) return;
    this.initialized = true;
    this.io = io;

    this.di.RealtimeAdminService.setIO(io);
    this.instrumentRealtimeEvents(io);

    io.on('connection', socket => {
      // Websockets never pass through the request logger, so without these lines
      // a client that connects and immediately drops leaves no trace at all.
      logActivity('info', 'realtime', `[realtime] connect socket=${socket.id} ${this.identityLabel(socket)}`);
      socket.on(REALTIME_SOCKET_EVENTS.subscribe, (model: unknown, ack?: SubscriptionAck) => {
        this.updateSubscription(socket, model, true, ack);
      });
      socket.on(REALTIME_SOCKET_EVENTS.unsubscribe, (model: unknown, ack?: SubscriptionAck) => {
        this.updateSubscription(socket, model, false, ack);
      });
      socket.on(REALTIME_TOPIC_EVENTS.join, (payload: unknown, ack?: (a: unknown) => void) => {
        // `join` awaits the realtime limits on the first subscription; the ack is
        // how the client learns the outcome, so nothing waits on it here.
        void this.di.RealtimeTopicService.join(socket, (payload ?? {}) as { topic?: unknown }, ack as never);
      });
      socket.on(REALTIME_TOPIC_EVENTS.leave, (payload: unknown, ack?: (a: unknown) => void) =>
        this.di.RealtimeTopicService.leave(socket, (payload ?? {}) as { topic?: unknown }, ack as never)
      );
      socket.on(REALTIME_TOPIC_EVENTS.message, (envelope: unknown, ack?: (result: 'ok' | 'error') => void) =>
        this.di.RealtimeTopicService.relay(socket, envelope, ack)
      );
      socket.on('disconnect', (reason: string) => {
        logActivity('info', 'realtime', `[realtime] disconnect socket=${socket.id} reason=${reason}`);
        this.di.RealtimePresenceService.handleDisconnect(socket);
        this.di.RealtimeTopicService.cleanup(socket);
      });
    });
  }

  getSubscriberGroups(model: string): SubscriberIdentityGroup[] {
    const room = realtimeModelRoom(model);
    if (!this.io || !room) return [];

    const socketIds = this.io.sockets.adapter.rooms.get(room);
    if (!socketIds?.size) return [];

    const groups = new Map<string, SubscriberIdentityGroup>();
    for (const socketId of socketIds) {
      const socket = this.io.sockets.sockets.get(socketId);
      if (!socket) continue;

      const user = this.socketUser(socket);
      const key = user ? `user:${user.id}:${user.role}` : 'anonymous';
      const group = groups.get(key);
      if (group) group.socketIds.push(socketId);
      else groups.set(key, { key, user, socketIds: [socketId] });
    }
    return Array.from(groups.values());
  }

  getSubscriberSocketIds(model: string): Set<string> {
    return new Set(this.getSubscriberGroups(model).flatMap(group => group.socketIds));
  }

  emitToSocketIds(socketIds: Iterable<string>, event: string, payload: unknown): void {
    for (const socketId of socketIds) {
      this.io?.sockets.sockets.get(socketId)?.emit(event, payload);
    }
  }

  /**
   * Emit a prebuilt rt:msg envelope to a topic. Returns how many sockets it
   * was sent to.
   */
  emitEnvelopeToTopic(topic: string, envelope: unknown, privateAudience?: PrivateTopicAudience): number {
    if (!privateAudience) {
      const room = realtimeTopicRoom(topic);
      this.io?.to(room).emit(REALTIME_TOPIC_EVENTS.message, envelope);
      return this.io?.sockets.adapter.rooms.get(room)?.size ?? 0;
    }
    let sent = 0;
    for (const socketId of this.io?.sockets.adapter.rooms.get(realtimeTopicRoom(topic, true)) ?? []) {
      if (socketId === privateAudience.exceptSocketId) continue;
      const socket = this.io?.sockets.sockets.get(socketId);
      if (!socket || !this.di.RealtimeTopicService.canReceivePrivate(socket, topic, privateAudience.extension)) continue;
      socket.emit(REALTIME_TOPIC_EVENTS.message, envelope);
      sent += 1;
    }
    return sent;
  }

  /** Server-side broadcast to a channel topic. Returns the current member count. */
  broadcastToTopic(topic: string, event: string, payload: unknown, isPrivate = false): number {
    const envelope = { topic, type: 'broadcast', event, payload };
    return isPrivate
      ? this.emitEnvelopeToTopic(topic, envelope, { extension: 'broadcast' })
      : this.emitEnvelopeToTopic(topic, envelope);
  }

  private updateSubscription(socket: Socket, rawModel: unknown, subscribe: boolean, ack?: SubscriptionAck): void {
    const respond = typeof ack === 'function' ? ack : undefined;
    const model = typeof rawModel === 'string' ? normalizeRealtimeModel(rawModel) : null;
    const room = model ? realtimeModelRoom(model) : null;
    if (!model || !room) {
      logActivity('warn', 'realtime', `[realtime] rejected subscription to "${String(rawModel)}" socket=${socket.id}`);
      respond?.({ ok: false, error: 'Invalid realtime model.' });
      return;
    }

    const operation = subscribe ? socket.join(room) : socket.leave(room);
    Promise.resolve(operation).then(
      () => {
        logActivity(
          'info',
          'realtime',
          `[realtime] ${subscribe ? 'subscribe' : 'unsubscribe'} model=${model} socket=${socket.id}`
        );
        respond?.({ ok: true, model });
      },
      () => {
        logActivity('error', 'realtime', `[realtime] subscription failed model=${model} socket=${socket.id}`);
        respond?.({ ok: false, error: 'Realtime subscription failed.' });
      }
    );
  }

  private identityLabel(socket: Socket): string {
    const user = this.socketUser(socket);
    return user ? `user=${user.id}` : 'anonymous';
  }

  private socketUser(socket: Socket): RealtimeSocketUser | null {
    const user = socket.data?.user as Partial<RealtimeSocketUser> | undefined;
    if (!user?.id) return null;
    return { id: String(user.id), role: String(user.role ?? 'USER') };
  }

  private instrumentRealtimeEvents(io: Server): void {
    const originalEmit = io.emit.bind(io);
    (io as any).emit = (event: string, ...args: any[]) => {
      this.di.RealtimeAdminService.pushEvent({
        channel: 'broadcast',
        event,
        payload: args[0] ?? null,
        at: Date.now(),
      });
      return originalEmit(event, ...args);
    };

    io.use((socket: Socket, next) => {
      const originalSocketEmit = socket.emit.bind(socket);
      (socket as any).emit = (event: string, ...args: any[]) => {
        const channel = Array.from(socket.rooms).find(room => room !== socket.id) ?? 'direct';
        this.di.RealtimeAdminService.pushEvent({
          channel,
          event,
          payload: args[0] ?? null,
          at: Date.now(),
        });
        return originalSocketEmit(event, ...args);
      };
      next();
    });
  }
}
