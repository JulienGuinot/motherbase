import type { RealtimeEvent } from '@/features/database/types';

export type MessageType = 'broadcast' | 'presence' | 'postgres' | 'system';

export const MESSAGE_TYPE_META: Record<MessageType, { label: string; color: string }> = {
  broadcast: { label: 'Broadcast', color: 'var(--purple)' },
  presence: { label: 'Presence', color: 'var(--amber)' },
  postgres: { label: 'Postgres', color: 'var(--green)' },
  system: { label: 'System', color: 'var(--text-mute)' },
};

export const ALL_MESSAGE_TYPES = Object.keys(MESSAGE_TYPE_META) as MessageType[];

/** Classify an instrumented realtime event into a Supabase message type. */
export function classifyMessage(event: RealtimeEvent): MessageType {
  const name = event.event ?? '';
  const payloadType = (event.payload as { type?: string } | null)?.type;
  if (name === 'rt:msg' && payloadType) {
    if (payloadType === 'postgres_changes') return 'postgres';
    if (payloadType === 'presence') return 'presence';
    if (payloadType === 'broadcast') return 'broadcast';
    return 'system';
  }
  if (/:(created|updated|deleted)$/.test(name)) return 'postgres';
  if (name.startsWith('phx') || name.startsWith('rt:') || name.startsWith('presence')) return 'system';
  return 'broadcast';
}

export function countByMessageType(events: RealtimeEvent[]): Record<MessageType, number> {
  return events.reduce(
    (acc, event) => {
      acc[classifyMessage(event)] += 1;
      return acc;
    },
    { broadcast: 0, presence: 0, postgres: 0, system: 0 } as Record<MessageType, number>
  );
}
