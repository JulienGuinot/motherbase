'use client';

import { useMemo, useState } from 'react';
import { AlertCircle, Plus } from 'lucide-react';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { Badge } from '@/shared/ui/Badge';
import { CodeBlock } from '@/shared/ui/CodeBlock';
import { EmptyState } from '@/shared/ui/EmptyState';
import { QueryState } from '@/shared/ui/QueryState';
import { Section } from '@/shared/ui/Section';
import { ToggleRow } from '@/shared/ui/Toggle';
import { WriteButton } from '@/shared/ui/WriteButton';
import { formatDuration, formatRelativeTime } from '@/shared/lib/format';
import { useQueueAdmin, useQueues } from '@/features/database/hooks/useQueues';
import { QueueCreateModal } from '@/features/database/components/QueueCreateModal';
import { QueueDrawer } from '@/features/database/components/QueueDrawer';
import type { QueueInfo, QueueList } from '@/features/database/api/queues.api';

const CLIENT_SNIPPET = `const { data, error } = await supabase
  .schema('pgmq_public')
  .rpc('send', { queue_name: 'email_jobs', message: { to: 'ada@example.com' } })`;

/** Age in seconds, as the queue table shows it: short, and '-' for an empty queue. */
const age = (seconds: number | null) =>
  seconds == null ? '-' : seconds < 60 ? `${seconds}s` : formatDuration(seconds);

function NotInstalled({ status, onEnable, enabling }: { status: QueueList; onEnable: () => void; enabling: boolean }) {
  return (
    <div className="card flex items-start gap-3 p-4">
      <AlertCircle size={16} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 1 }} />
      <div className="space-y-2 text-[13px]">
        <p>Queues run on the pgmq extension, which is not enabled for this project.</p>
        {status.available ? (
          <WriteButton onClick={onEnable} disabled={enabling} className="btn btn-primary">
            {enabling ? 'Enabling…' : 'Enable Queues'}
          </WriteButton>
        ) : (
          <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
            This database image has no pgmq. Rebuild images with <code className="mono">deploy/build-images.sh</code>{' '}
            and recreate the project&apos;s database container.
          </p>
        )}
      </div>
    </div>
  );
}

function QueueTable({ queues, onOpen }: { queues: QueueInfo[]; onOpen: (queue: QueueInfo) => void }) {
  return (
    <div className="card overflow-x-auto p-0">
      <table className="console w-full">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>RLS</th>
            <th className="text-right">Messages</th>
            <th className="text-right">Visible</th>
            <th className="text-right">Oldest</th>
            <th className="text-right">Total sent</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {queues.map(queue => (
            <tr key={queue.name} className="cursor-pointer" onClick={() => onOpen(queue)}>
              <td className="mono">{queue.name}</td>
              <td>
                <Badge>{queue.type}</Badge>
              </td>
              <td>
                <Badge tone={queue.rlsEnabled ? 'success' : 'warn'} dot>
                  {queue.rlsEnabled ? 'on' : 'off'}
                </Badge>
              </td>
              <td className="text-right tabular-nums">{queue.length.toLocaleString()}</td>
              <td className="text-right tabular-nums">{queue.visibleLength.toLocaleString()}</td>
              <td className="text-right tabular-nums">{age(queue.oldestMsgAgeSec)}</td>
              <td className="text-right tabular-nums">{queue.totalMessages.toLocaleString()}</td>
              <td title={queue.createdAt}>{formatRelativeTime(queue.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Queues() {
  const query = useQueues();
  const admin = useQueueAdmin();
  const [creating, setCreating] = useState(false);
  const [openName, setOpenName] = useState<string | null>(null);

  // Keep the drawer on the live row, so its counts follow the 5s poll.
  const open = useMemo(
    () => (openName ? query.data?.queues.find(q => q.name === openName) ?? null : null),
    [openName, query.data],
  );
  const installed = query.data?.installed ?? false;

  return (
    <>
      <PageShell width="wide">
        <PageHeader
          title="Queues"
          subtitle="Durable message queues in Postgres, on pgmq. Messages are guaranteed to be delivered exactly once within a visibility window."
          actions={
            installed ? (
              <WriteButton onClick={() => setCreating(true)} className="btn btn-primary">
                <Plus size={12} /> Create queue
              </WriteButton>
            ) : undefined
          }
        />

        <QueryState query={query} errorTitle="Could not load queues" isEmpty={() => false}>
          {data =>
            !data.installed ? (
              <NotInstalled status={data} onEnable={() => admin.enable.mutate()} enabling={admin.enable.isPending} />
            ) : (
              <div className="space-y-4">
                <Section title="API access">
                  <ToggleRow
                    label="Expose Queues via the API"
                    hint="Creates the pgmq_public schema (send, send_batch, read, pop, archive, delete) so clients reach queues through /rest/v1/rpc. Each call runs as the caller: grant roles access per queue under Permissions."
                    checked={data.exposed}
                    onChange={enabled => admin.setExposed.mutate(enabled)}
                  />
                  {data.exposed && (
                    <div className="mt-3">
                      <CodeBlock value={CLIENT_SNIPPET} label="Client" language="typescript" size="sm" />
                    </div>
                  )}
                </Section>

                {data.queues.length === 0 ? (
                  <div className="card">
                    <EmptyState
                      size="md"
                      mascot="sleeping"
                      title="No queues yet"
                      description="Create a queue, then send messages to it from SQL, a client or an edge function."
                      action={
                        <WriteButton onClick={() => setCreating(true)} className="btn btn-primary">
                          <Plus size={12} /> Create queue
                        </WriteButton>
                      }
                    />
                  </div>
                ) : (
                  <QueueTable queues={data.queues} onOpen={queue => setOpenName(queue.name)} />
                )}
              </div>
            )
          }
        </QueryState>
      </PageShell>

      {creating && query.data && (
        <QueueCreateModal
          partitionedAvailable={query.data.partitionedAvailable}
          saving={admin.create.isPending}
          onClose={() => setCreating(false)}
          onCreate={input => admin.create.mutate(input, { onSuccess: () => setCreating(false) })}
        />
      )}

      {open && <QueueDrawer queue={open} onClose={() => setOpenName(null)} />}
    </>
  );
}
