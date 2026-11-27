import { useState } from 'react';
import { Webhook as WebhookIcon, Trash2, Send, ToggleLeft, ToggleRight, Edit2, Clock, Activity, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import CopyButton from '@/shared/ui/CopyButton';
import { webhooksApi } from '@/features/database/api/webhooks.api';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import DetailDrawer, { type DrawerTab } from '@/shared/ui/DetailDrawer';
import { formatEventSpec, type EventTableMeta } from '@/shared/lib/event-utils';
import { useWebhookDeliveries } from '@/features/database/hooks/useWebhooks';
import type { Hook } from '@/features/database/types';
import { EmptyState } from '@/shared/ui/EmptyState';
import { Field } from '@/shared/ui/Field';
import { SkeletonList } from '@/shared/ui/Skeleton';

export function WebhookDrawer({
  hook,
  eventTables,
  onClose,
  onEdit,
  onTest,
  onToggle,
  onDelete,
}: {
  hook: Hook;
  eventTables: EventTableMeta[];
  onClose: () => void;
  onEdit: () => void;
  onTest: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [tab, setTab] = useState<'config' | 'deliveries'>('config');
  const [revealed, setRevealed] = useState(false);
  const queryClient = useQueryClient();
  const rotate = useMutation({
    mutationFn: () => webhooksApi.rotateSecret(hook.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['webhooks'] }),
  });

  async function confirmRotate() {
    const confirmed = await confirmDialog({
      title: 'Rotate the signing secret?',
      description: 'The current secret stops verifying immediately. Update the receiver with the new one.',
      confirmLabel: 'Rotate',
      tone: 'danger',
    });
    if (confirmed) rotate.mutate();
  }

  const delivQ = useWebhookDeliveries(hook.id, tab === 'deliveries');
  const deliveries = delivQ.data ?? [];

  const avatar = (
    <div
      className="flex h-11 w-11 shrink-0 items-center justify-center"
      style={{ background: 'var(--surface-2)', color: hook.enabled ? 'var(--green)' : 'var(--text-mute)', borderRadius: 999 }}
    >
      <WebhookIcon size={18} />
    </div>
  );

  const tabs: DrawerTab[] = [
    { id: 'config', label: 'Config', icon: WebhookIcon },
    { id: 'deliveries', label: 'Deliveries', icon: Activity },
  ];

  const footer = (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <button onClick={onEdit} className="btn"><Edit2 size={12} /> Edit</button>
        <button onClick={onTest} className="btn"><Send size={12} /> Send test</button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button onClick={onToggle} className="btn">
          {hook.enabled ? <><ToggleLeft size={12} /> Disable</> : <><ToggleRight size={12} /> Enable</>}
        </button>
        <button onClick={onDelete} className="btn justify-center" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>
          <Trash2 size={12} /> Delete
        </button>
      </div>
    </div>
  );

  return (
    <DetailDrawer
      title={hook.name}
      subtitle={hook.enabled ? 'Enabled' : 'Disabled'}
      avatar={avatar}
      tabs={tabs}
      activeTab={tab}
      onTab={id => setTab(id as 'config' | 'deliveries')}
      onClose={onClose}
      footer={footer}
      width="32rem"
    >
      {tab === 'config' ? (
        <div className="space-y-5">
          <Field label="URL">
            <div className="mono break-all text-[12px]" style={{ color: 'var(--text-dim)' }}>{hook.url}</div>
          </Field>
          <div>
            <div className="label mb-2">Events</div>
            <div className="flex flex-wrap gap-1.5">
              {hook.events.map(e => <span key={e} className="chip">{formatEventSpec(e, eventTables)}</span>)}
            </div>
          </div>
          <Field label="Signing secret">
            <div className="flex items-center gap-2">
              <div className="mono min-w-0 flex-1 break-all text-[11px]" style={{ color: 'var(--text-dim)' }}>
                {revealed ? hook.secret : 'whsec_' + '•'.repeat(24)}
              </div>
              <button
                onClick={() => setRevealed(v => !v)}
                className="btn btn-ghost"
                title={revealed ? 'Hide secret' : 'Reveal secret'}
                aria-label={revealed ? 'Hide secret' : 'Reveal secret'}
              >
                {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
              <CopyButton value={hook.secret} title="Copy secret" />
              <button
                onClick={confirmRotate}
                disabled={rotate.isPending}
                className="btn btn-ghost"
                title="Rotate secret"
                aria-label="Rotate secret"
              >
                <RefreshCw size={13} className={rotate.isPending ? 'animate-spin' : undefined} />
              </button>
            </div>
            <div className="mt-1 text-[11px]" style={{ color: 'var(--text-mute)' }}>
              Every delivery carries <span className="mono">webhook-id</span>, <span className="mono">webhook-timestamp</span> and{' '}
              <span className="mono">webhook-signature</span> (Standard Webhooks). Verify them with this secret.
            </div>
            {rotate.isError && (
              <div className="mt-1 text-[11px]" style={{ color: 'var(--danger)' }}>The secret could not be rotated. Try again.</div>
            )}
          </Field>
          <Field label="Webhook ID">
            <div className="mono break-all text-[11px]" style={{ color: 'var(--text-mute)' }}>{hook.id}</div>
          </Field>
          <Field label="Created">
            <div className="text-[12px]" style={{ color: 'var(--text-dim)' }}>{new Date(hook.createdAt).toLocaleString()}</div>
          </Field>
        </div>
      ) : (
        <div className="space-y-2">
          {delivQ.isLoading && <SkeletonList rows={4} height={44} />}
          {!delivQ.isLoading && deliveries.length === 0 && (
            <EmptyState title="No deliveries yet" description="Send a test payload, or trigger a matching event on the table this hook watches." />
          )}
          {deliveries.map(d => (
            <div key={d.id} className="flex items-center gap-3 border hairline p-3" style={{ borderRadius: 'var(--radius-sm)' }}>
              <span
                className="chip tabular-nums shrink-0"
                style={{ color: d.ok ? 'var(--green)' : 'var(--danger)', borderColor: d.ok ? 'var(--green)' : 'var(--danger)' }}
              >
                {d.status || 'ERR'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="mono truncate text-[12px]">
                  {d.event}
                  {d.test && <span className="chip ml-2" style={{ fontSize: 10 }}>test</span>}
                </div>
                <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-mute)' }}>
                  <span className="inline-flex items-center gap-1"><Clock size={9} /> {new Date(d.createdAt).toLocaleString()}</span>
                  <span className="tabular-nums">{d.durationMs}ms</span>
                  {d.attempt > 1 && <span className="tabular-nums">attempt {d.attempt}</span>}
                  {d.errorMessage && <span className="truncate" style={{ color: 'var(--danger)' }}>{d.errorMessage}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </DetailDrawer>
  );
}
