'use client';

import { useSettingsDraft, type AuthPanelProps } from '@/features/auth/lib/settings-panel';
import { Section } from '@/shared/ui/Section';
import { ToggleRow } from '@/shared/ui/Toggle';
import { StatusDot } from '@/shared/ui/Badge';
import { readinessOf, readinessTone } from '@/features/auth/lib/readiness';
import { WebhookFields } from '@/features/auth/components/hooks/WebhookFields';

export function SendHookPanel({ initial, status, onSaved, toast, editable }: AuthPanelProps) {
  const { v, patch, saving, save } = useSettingsDraft(
    'auth.hooks.send',
    {
      enabled: !!initial.enabled,
      email: !!initial.email,
      sms: !!initial.sms,
      webhookUrl: String(initial.webhookUrl ?? ''),
      webhookSecret: (initial.webhookSecret as string) ?? '',
    },
    { toast, onSaved, savedTitle: 'Delivery override saved' },
  );
  const state = readinessOf(v.enabled, status?.configured);

  return (
    <Section
      title="Delivery override (send email / SMS)"
      actions={<StatusDot tone={readinessTone(state)} />}
      description="Send OTP codes, magic links and 2FA codes through your own provider. Fails open. If the webhook doesn't claim a message, built-in delivery still runs."
      footer={<button className="btn btn-primary" disabled={!editable || saving} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>}
    >
      <ToggleRow disabled={!editable} label="Enable delivery override" hint="Route auth messages to your webhook." checked={v.enabled} onChange={x => patch({ enabled: x })} />
      {v.enabled && (
        <>
          <div className="flex gap-6">
            <ToggleRow disabled={!editable} label="Email" hint="OTP + magic links." checked={v.email} onChange={x => patch({ email: x })} />
            <ToggleRow disabled={!editable} label="SMS" hint="Phone + 2FA codes." checked={v.sms} onChange={x => patch({ sms: x })} />
          </div>
          <WebhookFields disabled={!editable} url={v.webhookUrl} secret={v.webhookSecret} onUrl={x => patch({ webhookUrl: x })} onSecret={x => patch({ webhookSecret: x })} />
          <p className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
            The webhook receives <code>{'{ event, message }'}</code> and should return <code>{'{ handled: true }'}</code> once it has delivered.
          </p>
        </>
      )}
    </Section>
  );
}
