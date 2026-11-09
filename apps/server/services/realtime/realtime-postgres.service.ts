import { normalizeRealtimeModel, REALTIME_TOPIC_EVENTS, type RealtimePostgresChangeConfig } from '@motherbase/contracts';
import type { Socket } from 'socket.io';
import BaseContext from '../../context/base-context';
import { realtimeModelRoom } from '../socket.service';
import type { RealtimeAction, RealtimeModel } from './realtime-broadcast.service';

interface TopicBinding {
  topic: string;
  binding: RealtimePostgresChangeConfig;
  bindingId?: number;
}

const ACTION_TO_EVENTTYPE: Record<RealtimeAction, 'INSERT' | 'UPDATE' | 'DELETE'> = {
  created: 'INSERT',
  updated: 'UPDATE',
  deleted: 'DELETE',
};

const FILTER = /^([^=]+)=(eq|neq|gt|gte|lt|lte|in)\.(.*)$/;

/**
 * Routes RLS-approved row changes to channel topics subscribed via
 * `postgres_changes`. Topic subscribers join the model's realtime room so the
 * existing outbox delivery + RLS + delete-audience machinery already gates who
 * receives a row; this service only translates a delivered row into the
 * Supabase `postgres_changes` envelope on the right topic, applying the
 * client-requested column filter (a narrowing, never a widening, of RLS).
 */
export class RealtimePostgresService extends BaseContext {
  // normalized model -> socketId -> bindings
  private readonly byModel = new Map<string, Map<string, TopicBinding[]>>();
  // `${socketId}:${modelKey}` -> model-room refcount for this socket
  private readonly roomRefs = new Map<string, number>();

  register(socket: Socket, topic: string, binding: RealtimePostgresChangeConfig, bindingId?: number): void {
    const modelKey = normalizeRealtimeModel(binding.table);
    const room = modelKey ? realtimeModelRoom(modelKey) : null;
    if (!modelKey || !room) return;
    const bySocket = this.byModel.get(modelKey) ?? new Map<string, TopicBinding[]>();
    const list = bySocket.get(socket.id) ?? [];
    list.push({ topic, binding, bindingId });
    bySocket.set(socket.id, list);
    this.byModel.set(modelKey, bySocket);

    const refKey = `${socket.id}:${modelKey}`;
    const refs = this.roomRefs.get(refKey) ?? 0;
    if (refs === 0) void socket.join(room);
    this.roomRefs.set(refKey, refs + 1);
  }

  /** Remove all of a socket's bindings for a single topic (channel unsubscribe). */
  unregisterTopic(socket: Socket, topic: string): void {
    for (const [modelKey, bySocket] of this.byModel) {
      const list = bySocket.get(socket.id);
      if (!list) continue;
      const kept = list.filter(entry => entry.topic !== topic);
      const removed = list.length - kept.length;
      if (!removed) continue;
      this.applyRemoval(socket, modelKey, bySocket, kept, removed);
    }
  }

  /** Remove every binding for a disconnecting socket (rooms auto-left by socket.io). */
  unregisterSocket(socket: Socket): void {
    for (const [modelKey, bySocket] of this.byModel) {
      if (!bySocket.delete(socket.id)) continue;
      if (bySocket.size === 0) this.byModel.delete(modelKey);
      this.roomRefs.delete(`${socket.id}:${modelKey}`);
    }
  }

  /**
   * Fan a delivered (already RLS-approved) row to every topic subscriber among
   * `socketIds` whose event + column filter match. Called by RealtimeBroadcastService.
   *
   * Returns the socket ids that received at least one envelope for this row, so
   * the caller can skip the legacy flat event for them (see the dedup comment in
   * RealtimeBroadcastService.deliver).
   */
  fanToTopics(socketIds: Iterable<string>, model: RealtimeModel, action: RealtimeAction, row: unknown): Set<string> {
    const delivered = new Set<string>();
    const modelKey = normalizeRealtimeModel(model.model);
    if (!modelKey) return delivered;
    const bySocket = this.byModel.get(modelKey);
    if (!bySocket) return delivered;

    for (const socketId of socketIds) {
      const list = bySocket.get(socketId);
      if (!list) continue;
      for (const { topic, binding, bindingId } of list) {
        if (!this.eventMatches(binding.event, action)) continue;
        if (binding.filter && !this.matchFilter(binding.filter, row)) continue;
        const envelope = {
          topic,
          bindingId,
          type: 'postgres_changes' as const,
          event: ACTION_TO_EVENTTYPE[action],
          payload: this.shapePayload(binding, action, row),
        };
        this.di.SocketService?.emitToSocketIds?.([socketId], REALTIME_TOPIC_EVENTS.message, envelope);
        delivered.add(socketId);
      }
    }
    return delivered;
  }

  private applyRemoval(
    socket: Socket,
    modelKey: string,
    bySocket: Map<string, TopicBinding[]>,
    kept: TopicBinding[],
    removed: number
  ): void {
    if (kept.length) bySocket.set(socket.id, kept);
    else bySocket.delete(socket.id);
    if (bySocket.size === 0) this.byModel.delete(modelKey);

    const refKey = `${socket.id}:${modelKey}`;
    const refs = (this.roomRefs.get(refKey) ?? removed) - removed;
    if (refs <= 0) {
      this.roomRefs.delete(refKey);
      const room = realtimeModelRoom(modelKey);
      if (room) void socket.leave(room);
    } else {
      this.roomRefs.set(refKey, refs);
    }
  }

  private eventMatches(bindingEvent: RealtimePostgresChangeConfig['event'], action: RealtimeAction): boolean {
    return bindingEvent === '*' || bindingEvent === ACTION_TO_EVENTTYPE[action];
  }

  private shapePayload(binding: RealtimePostgresChangeConfig, action: RealtimeAction, row: unknown) {
    const eventType = ACTION_TO_EVENTTYPE[action];
    const isDelete = action === 'deleted';
    return {
      schema: binding.schema ?? 'public',
      table: binding.table,
      eventType,
      new: isDelete ? {} : (row ?? {}),
      old: isDelete ? (row ?? {}) : {},
      commit_timestamp: new Date().toISOString(),
    };
  }

  private matchFilter(filter: string, row: unknown): boolean {
    const parsed = FILTER.exec(filter);
    if (!parsed) return true; // unrecognised filter: don't drop RLS-approved rows
    const [, column, op, raw] = parsed;
    const cell = (row as Record<string, unknown> | null | undefined)?.[column];
    switch (op) {
      case 'eq':
        return String(cell) === raw;
      case 'neq':
        return String(cell) !== raw;
      case 'gt':
        return Number(cell) > Number(raw);
      case 'gte':
        return Number(cell) >= Number(raw);
      case 'lt':
        return Number(cell) < Number(raw);
      case 'lte':
        return Number(cell) <= Number(raw);
      case 'in':
        return raw
          .replace(/^\(|\)$/g, '')
          .split(',')
          .includes(String(cell));
      default:
        return true;
    }
  }
}
