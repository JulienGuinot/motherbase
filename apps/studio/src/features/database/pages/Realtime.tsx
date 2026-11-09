'use client';

import { useMemo, useState } from 'react';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { Tabs } from '@/shared/ui/Tabs';
import { RealtimeQueuePanel } from '@/features/database/components/RealtimeQueuePanel';
import { useContextMenu } from '@/shared/hooks/useContextMenu';
import { useRealtimeChannels, useRealtimeEvents, useRealtimePresence } from '@/features/database/hooks/useRealtime';
import {
  ALL_MESSAGE_TYPES,
  classifyMessage,
  countByMessageType,
  type MessageType,
} from '@/features/database/lib/realtime-messages';
import { RealtimeChannelList } from '@/features/database/components/RealtimeChannelList';
import { RealtimeConfigPanel } from '@/features/database/components/RealtimeConfigPanel';
import { ChannelContextMenu, MessageContextMenu } from '@/features/database/components/RealtimeContextMenus';
import { RealtimeMessageLog } from '@/features/database/components/RealtimeMessageLog';
import { RealtimePresencePanel } from '@/features/database/components/RealtimePresencePanel';
import { RealtimeSettingsPanel } from '@/features/database/components/RealtimeSettingsPanel';
import { RealtimePoliciesPanel } from '@/features/database/components/RealtimePoliciesPanel';
import type { ChannelInfo, RealtimeEvent } from '@/features/database/types';

const TABS = [
  { id: 'inspector', label: 'Inspector' },
  { id: 'policies', label: 'Policies' },
  { id: 'settings', label: 'Settings' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function Realtime() {
  const [view, setView] = useState<TabId>('inspector');
  const [channel, setChannel] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [types, setTypes] = useState<Set<MessageType>>(() => new Set(ALL_MESSAGE_TYPES));

  const channelMenu = useContextMenu<ChannelInfo>();
  const messageMenu = useContextMenu<RealtimeEvent>();

  const channelsQuery = useRealtimeChannels();
  const eventsQuery = useRealtimeEvents(channel);
  const presenceQuery = useRealtimePresence(channel);

  const events = useMemo(() => eventsQuery.data ?? [], [eventsQuery.data]);
  const counts = useMemo(() => countByMessageType(events), [events]);
  const filtered = useMemo(() => {
    const term = search.toLowerCase();
    return events.filter(
      event =>
        types.has(classifyMessage(event)) &&
        (!term || event.event.toLowerCase().includes(term) || event.channel.toLowerCase().includes(term))
    );
  }, [events, types, search]);

  const toggleType = (type: MessageType) =>
    setTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });

  return (
    <PageShell>
      <PageHeader title="Realtime" subtitle="Live channels with broadcast, presence, and postgres_changes messages" />

      <Tabs items={TABS} value={view} onChange={setView} />

      {/* Queue depth, which the traffic inspector below cannot show. */}
      {view === 'inspector' && <RealtimeQueuePanel />}

      {/* The inspector column is minmax(0,1fr) and its content min-w-0. Without
          both, a long payload or channel name in the message log stretches the
          track and widens the whole page, instead of scrolling inside the log's
          own overflow-auto. */}
      {view === 'settings' ? (
        <RealtimeSettingsPanel />
      ) : view === 'policies' ? (
        <RealtimePoliciesPanel />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
          <RealtimeChannelList
            channels={channelsQuery.data ?? []}
            isLoading={channelsQuery.isLoading}
            selected={channel}
            onSelect={setChannel}
            onContextMenu={channelMenu.onContextMenu}
          />

          <div className="flex min-w-0 flex-col gap-4">
            {channel && presenceQuery.data && (
              <RealtimePresencePanel channel={channel} users={presenceQuery.data} />
            )}

            <RealtimeMessageLog
              events={filtered}
              isLoading={eventsQuery.isLoading}
              counts={counts}
              typeFilter={types}
              onToggleType={toggleType}
              search={search}
              onSearch={setSearch}
              onContextMenu={messageMenu.onContextMenu}
            />

            <RealtimeConfigPanel />
          </div>
        </div>
      )}

      {channelMenu.menu && (
        <ChannelContextMenu
          x={channelMenu.menu.x}
          y={channelMenu.menu.y}
          channel={channelMenu.menu.data}
          selected={channel}
          onClose={channelMenu.close}
          onInspect={setChannel}
          onFilter={setSearch}
          onClearSelection={() => setChannel(null)}
        />
      )}

      {messageMenu.menu && (
        <MessageContextMenu
          x={messageMenu.menu.x}
          y={messageMenu.menu.y}
          event={messageMenu.menu.data}
          onClose={messageMenu.close}
          onFilter={setSearch}
        />
      )}
    </PageShell>
  );
}
