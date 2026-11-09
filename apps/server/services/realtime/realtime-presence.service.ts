import { randomUUID } from 'crypto';
import { REALTIME_TOPIC_EVENTS, realtimeTopicRoom } from '@motherbase/contracts';
import type { Socket } from 'socket.io';
import BaseContext from '../../context/base-context';

interface StoredPresence {
  ref: string;
  key: string;
  state: Record<string, unknown>;
  socketId: string;
  topic: string;
  isPrivate: boolean;
}

export type PresenceStateMap = Record<string, Array<Record<string, unknown>>>;

/**
 * Per-topic presence tracking. On every change (track / untrack / disconnect)
 * the full presence state for the topic is emitted to the room; the client
 * diffs it locally into Supabase's sync/join/leave events.
 *
 * The public and the private channel of one topic are separate audiences, so
 * presence is kept per room, not per topic: a private tracker is never visible
 * to a public subscriber of the same name.
 */
export class RealtimePresenceService extends BaseContext {
  // room -> ref -> presence
  private readonly byTopic = new Map<string, Map<string, StoredPresence>>();

  track(socket: Socket, topic: string, state: Record<string, unknown>, key: string, isPrivate = false): { ref: string } {
    const ref = randomUUID();
    const room = realtimeTopicRoom(topic, isPrivate);
    const map = this.byTopic.get(room) ?? new Map<string, StoredPresence>();
    // One presence per socket per topic: a repeated track() replaces its own
    // entry instead of stacking refs. Without this, an often-updated state
    // (typing indicator, cursor) grows presenceState()[key] until disconnect.
    for (const [existingRef, presence] of map) {
      if (presence.socketId === socket.id) map.delete(existingRef);
    }
    map.set(ref, { ref, key, state: state ?? {}, socketId: socket.id, topic, isPrivate });
    this.byTopic.set(room, map);
    this.emitState(topic, isPrivate);
    return { ref };
  }

  untrack(socket: Socket, topic: string, isPrivate = false): void {
    const room = realtimeTopicRoom(topic, isPrivate);
    const map = this.byTopic.get(room);
    if (!map) return;
    let changed = false;
    for (const [ref, presence] of map) {
      if (presence.socketId === socket.id) {
        map.delete(ref);
        changed = true;
      }
    }
    if (map.size === 0) this.byTopic.delete(room);
    if (changed) this.emitState(topic, isPrivate);
  }

  /** Remove all of a socket's presences across every topic (on disconnect). */
  handleDisconnect(socket: Socket): void {
    const joined = new Map<string, StoredPresence>();
    for (const map of this.byTopic.values()) {
      for (const presence of map.values()) if (presence.socketId === socket.id) joined.set(presence.ref, presence);
    }
    for (const presence of joined.values()) this.untrack(socket, presence.topic, presence.isPrivate);
  }

  /** Send the current presence state for a topic to a single socket (on join). */
  sendStateTo(socket: Socket, topic: string, isPrivate = false): void {
    socket.emit(REALTIME_TOPIC_EVENTS.message, {
      topic,
      type: 'presence',
      event: 'state',
      payload: this.stateMap(realtimeTopicRoom(topic, isPrivate)),
    });
  }

  private emitState(topic: string, isPrivate: boolean): void {
    const envelope = {
      topic,
      type: 'presence',
      event: 'state',
      payload: this.stateMap(realtimeTopicRoom(topic, isPrivate)),
    };
    // A private presence state reaches only members allowed to read presence.
    if (isPrivate) this.di.SocketService.emitEnvelopeToTopic(topic, envelope, { extension: 'presence' });
    else this.di.SocketService.emitEnvelopeToTopic(topic, envelope);
  }

  private stateMap(room: string): PresenceStateMap {
    const map = this.byTopic.get(room);
    const out: PresenceStateMap = {};
    if (!map) return out;
    for (const presence of map.values()) {
      (out[presence.key] ??= []).push({ presence_ref: presence.ref, ...presence.state });
    }
    return out;
  }
}
