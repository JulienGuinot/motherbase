'use client';

import { useState } from 'react';
import { Archive, Eraser, Inbox, Lock, Send, Trash2 } from 'lucide-react';
import DetailDrawer from '@/shared/ui/DetailDrawer';
import { EmptyState } from '@/shared/ui/EmptyState';
import { Field } from '@/shared/ui/Field';
import JsonView from '@/shared/ui/JsonView';
import { Pager } from '@/shared/ui/Pager';
import { QueryState } from '@/shared/ui/QueryState';
import { Toggle } from '@/shared/ui/Toggle';
import { WriteButton } from '@/shared/ui/WriteButton';
import { formatRelativeTime } from '@/shared/lib/format';
import {
  QUEUE_PAGE_SIZE,
  useQueueAdmin,
  useQueueMessages,
  useQueuePermissions,
} from '@/features/database/hooks/useQueues';
import type {
  QueueInfo,
  QueueMessage,
  QueuePermissions,
  QueuePrivilege,
  QueueRole,
} from '@/features/database/api/queues.api';

type Tab = 'messages' | 'archive' | 'permissions';

const TABS = [
  { id: 'messages', label: 'Messages', icon: Inbox },
  { id: 'archive', label: 'Archive', icon: Archive },
  { id: 'permissions', label: 'Permissions', icon: Lock },
];

const ROLES: QueueRole[] = ['anon', 'authenticated'];

/** The composer's text as the JSON value pgmq will store, or why it is not one. */
function parseMessage(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Not valid JSON' };
  }
}
const PRIVILEGES: QueuePrivilege[] = ['select', 'insert', 'update', 'delete'];

function MessageRow({
  message,
  actions,
}: {
  message: QueueMessage;
  actions?: React.ReactNode;
}) {
  return (
    <li className="row-host space-y-2 border-t hairline py-3 first:border-t-0">
      <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-mute)' }}>
        <span className="mono" style={{ color: 'var(--text)' }}>#{message.msg_id}</span>
        <span>read {message.read_ct}×</span>
        <span title={message.enqueued_at}>enqueued {formatRelativeTime(message.enqueued_at)}</span>
        {message.archived_at ? (
          <span title={message.archived_at}>archived {formatRelativeTime(message.archived_at)}</span>
        ) : (
          <span title="Visibility timeout: a read hides the message from other readers until then">
            vt {new Date(message.vt).toLocaleTimeString()}
          </span>
        )}
        {actions && <span className="row-actions ml-auto flex gap-1">{actions}</span>}
      </div>
      <JsonView value={message.message} className="text-[11px]" />
    </li>
  );
}

function MessageList({ queue, archived }: { queue: QueueInfo; archived: boolean }) {
  const [page, setPage] = useState(1);
  const query = useQueueMessages(queue.name, archived, page);
  const admin = useQueueAdmin();

  return (
    <QueryState
      query={query}
      isEmpty={data => data.total === 0}
      errorTitle="Could not load messages"
      empty={
        <EmptyState
          title={archived ? 'Nothing archived' : 'The queue is empty'}
          description={archived ? 'Archived messages land here, kept for auditing.' : 'Send a message to see it here.'}
        />
      }
    >
      {data => (
        <div>
          <ul>
            {data.messages.map(message => (
              <MessageRow
                key={message.msg_id}
                message={message}
                actions={
                  !archived && (
                    <>
                      <WriteButton
                        className="btn btn-ghost"
                        title="Archive"
                        onClick={() => admin.archive.mutate({ name: queue.name, msgId: message.msg_id })}
                      >
                        <Archive size={12} />
                      </WriteButton>
                      <WriteButton
                        className="btn btn-ghost"
                        title="Delete"
                        style={{ color: 'var(--red)' }}
                        onClick={() => admin.deleteMessage.mutate({ name: queue.name, msgId: message.msg_id })}
                      >
                        <Trash2 size={12} />
                      </WriteButton>
                    </>
                  )
                }
              />
            ))}
          </ul>
          <div className="border-t hairline">
            <Pager
              page={page}
              pageCount={Math.max(1, Math.ceil(data.total / QUEUE_PAGE_SIZE))}
              pageSize={QUEUE_PAGE_SIZE}
              pageSizes={[QUEUE_PAGE_SIZE]}
              total={data.total}
              onPageChange={setPage}
              onPageSizeChange={() => undefined}
              label="messages"
            />
          </div>
        </div>
      )}
    </QueryState>
  );
}

/** Send one message, or read (consume) a batch the way a worker would. */
function MessageComposer({ queue }: { queue: QueueInfo }) {
  const admin = useQueueAdmin();
  const [body, setBody] = useState('{\n  "hello": "world"\n}');
  const [delay, setDelay] = useState(0);
  const [vt, setVt] = useState(30);
  const parsed = parseMessage(body);

  return (
    <div className="space-y-3 border-b hairline pb-4">
      <Field label="Message (JSON)" error={parsed.ok ? undefined : parsed.error}>
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          rows={4}
          className="input mono w-full resize-y"
          style={{ fontSize: 12 }}
        />
      </Field>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Delay (s)" className="w-24">
          <input type="number" min={0} value={delay} onChange={e => setDelay(Number(e.target.value))} className="input" />
        </Field>
        <WriteButton
          className="btn btn-primary"
          disabled={!parsed.ok || admin.send.isPending}
          onClick={() => parsed.ok && admin.send.mutate({ name: queue.name, message: parsed.value, delay })}
        >
          <Send size={12} /> Send
        </WriteButton>
        <span className="flex-1" />
        <Field label="Visibility (s)" className="w-28">
          <input type="number" min={0} value={vt} onChange={e => setVt(Number(e.target.value))} className="input" />
        </Field>
        <WriteButton
          className="btn"
          title="pgmq.read: returns the next message and hides it for the visibility timeout"
          disabled={admin.read.isPending}
          onClick={() => admin.read.mutate({ name: queue.name, vt, qty: 1 })}
        >
          Read next
        </WriteButton>
      </div>
      {admin.read.data && (
        <div className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
          {admin.read.data.length
            ? `Read #${admin.read.data[0].msg_id}: hidden from other readers for ${vt}s.`
            : 'No visible message to read.'}
        </div>
      )}
    </div>
  );
}

/** The editable grid, seeded once from the server's answer; remounted after each save lands. */
function PermissionsEditor({ queue, initial }: { queue: QueueInfo; initial: QueuePermissions }) {
  const admin = useQueueAdmin();
  const [draft, setDraft] = useState<QueuePermissions>(initial);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[13px]">Row level security</div>
          <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-mute)' }}>
            On: granted roles only reach messages a policy on <span className="mono">pgmq.q_{queue.name}</span>{' '}
            admits. Off: a grant is access to every message.
          </p>
        </div>
        <Toggle
          checked={draft.rlsEnabled}
          onChange={rlsEnabled => setDraft({ ...draft, rlsEnabled })}
          ariaLabel="Row level security"
        />
      </div>

      <table className="console w-full">
        <thead>
          <tr>
            <th>Role</th>
            {PRIVILEGES.map(p => (
              <th key={p} className="text-center">{p}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROLES.map(role => (
            <tr key={role}>
              <td className="mono">{role}</td>
              {PRIVILEGES.map(p => (
                <td key={p} className="text-center">
                  <input
                    type="checkbox"
                    aria-label={`${role} ${p}`}
                    checked={draft.roles[role][p]}
                    onChange={e =>
                      setDraft({
                        ...draft,
                        roles: { ...draft.roles, [role]: { ...draft.roles[role], [p]: e.target.checked } },
                      })
                    }
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
        send needs insert, read and pop need select and update, archive and delete need delete (and insert on the
        archive, granted with it). service_role always has full access.
      </p>

      <div className="flex justify-end">
        <WriteButton
          className="btn btn-primary"
          disabled={admin.setPermissions.isPending}
          onClick={() => admin.setPermissions.mutate({ name: queue.name, patch: draft })}
        >
          {admin.setPermissions.isPending ? 'Saving…' : 'Save permissions'}
        </WriteButton>
      </div>
    </div>
  );
}

function PermissionsPanel({ queue }: { queue: QueueInfo }) {
  const query = useQueuePermissions(queue.name);
  return (
    <QueryState query={query} errorTitle="Could not load permissions">
      {data => <PermissionsEditor key={query.dataUpdatedAt} queue={queue} initial={data} />}
    </QueryState>
  );
}

export function QueueDrawer({ queue, onClose }: { queue: QueueInfo; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('messages');
  const admin = useQueueAdmin();

  return (
    <DetailDrawer
      title={queue.name}
      subtitle={`${queue.type} queue · ${queue.length} message${queue.length === 1 ? '' : 's'} · ${queue.totalMessages} sent in total`}
      tabs={TABS}
      activeTab={tab}
      onTab={id => setTab(id as Tab)}
      onClose={onClose}
      width="40rem"
      footer={
        <div className="flex w-full justify-between gap-2">
          <WriteButton className="btn" onClick={() => admin.confirmPurge(queue)} disabled={queue.length === 0}>
            <Eraser size={12} /> Purge
          </WriteButton>
          <WriteButton className="btn" style={{ color: 'var(--red)' }} onClick={() => admin.confirmDrop(queue, onClose)}>
            <Trash2 size={12} /> Delete queue
          </WriteButton>
        </div>
      }
    >
      {tab === 'messages' && (
        <>
          <MessageComposer queue={queue} />
          <MessageList queue={queue} archived={false} />
        </>
      )}
      {tab === 'archive' && <MessageList queue={queue} archived />}
      {tab === 'permissions' && <PermissionsPanel queue={queue} />}
    </DetailDrawer>
  );
}
