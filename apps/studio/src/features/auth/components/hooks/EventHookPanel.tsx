'use client';

import { useSettingsDraft, type AuthPanelProps } from '@/features/auth/lib/settings-panel';
import { Section } from '@/shared/ui/Section';
import { ToggleRow } from '@/shared/ui/Toggle';
import { StatusDot } from '@/shared/ui/Badge';
import { readinessOf, readinessTone } from '@/features/auth/lib/readiness';
import { WebhookFields } from '@/features/auth/components/hooks/WebhookFields';
import { ListInput } from '@/shared/ui/ListInput';
import { joinList, splitList } from '@/shared/lib/list-values';

export function EventHookPanel({ initial, status, onSaved, toast, editable }: AuthPanelProps) {
  const { v, patch, saving, save } = useSettingsDraft(
    'auth.hooks.events',
    {
      enabled: !!initial.enabled,
      events: String(initial.events ?? ''),
      webhookUrl: String(initial.webhookUrl ?? ''),
      webhookSecret: (initial.webhookSecret as string) ?? '',
    },
    { toast, onSaved, savedTitle: 'Event webhook saved' },
  );
  const state = readinessOf(v.enabled, status?.configured);

  return (
    <Section
      title="Auth event webhook"
      actions={<StatusDot tone={readinessTone(state)} />}
      description="Fire-and-forget notification after auth requests. Audit trails, new-login alerts. Never blocks the user's request."
      footer={<button className="btn btn-primary" disabled={!editable || saving} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>}
    >
      <ToggleRow disabled={!editable} label="Enable event webhook" hint="POST a signed event on matching auth requests." checked={v.enabled} onChange={x => patch({ enabled: x })} />
      {v.enabled && (
        <>
          <label htmlFor="auth-event-hook-events" className="block">
            <span className="label mb-1 block">Events</span>
            <ListInput
              id="auth-event-hook-events"
              disabled={!editable}
              mono
              value={splitList(v.events)}
              placeholder="sign-in"
              onChange={events => patch({ events: joinList(events) })}
            />
            <span className="mt-1 block text-[11px]" style={{ color: 'var(--text-mute)' }}>
              Path fragments to match. Empty fires on sign-in and sign-up.
            </span>
          </label>
          <WebhookFields disabled={!editable} url={v.webhookUrl} secret={v.webhookSecret} onUrl={x => patch({ webhookUrl: x })} onSecret={x => patch({ webhookSecret: x })} />
        </>
      )}
    </Section>
  );
}
