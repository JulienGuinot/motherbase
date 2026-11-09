'use client';

import { useSettingsDraft, type AuthPanelProps } from '@/features/auth/lib/settings-panel';
import { Section } from '@/shared/ui/Section';
import { ToggleRow } from '@/shared/ui/Toggle';
import { StatusDot } from '@/shared/ui/Badge';
import { readinessOf, readinessTone } from '@/features/auth/lib/readiness';
import Select from '@/shared/ui/Select';
import { ListInput } from '@/shared/ui/ListInput';
import { joinList, splitList } from '@/shared/lib/list-values';
import { WebhookFields } from '@/features/auth/components/hooks/WebhookFields';

/** How the domain list is read: ignored, an allowlist, or a blocklist. */
type DomainMode = 'off' | 'allow' | 'block';

export function SignUpGatePanel({ initial, status, onSaved, toast, editable }: AuthPanelProps) {
  const { v, patch, saving, save } = useSettingsDraft(
    'auth.hooks.signUp',
    {
      enabled: !!initial.enabled,
      emailDomainMode: (initial.emailDomainMode as DomainMode) ?? 'off',
      emailDomains: String(initial.emailDomains ?? ''),
      webhookUrl: String(initial.webhookUrl ?? ''),
      webhookSecret: (initial.webhookSecret as string) ?? '',
    },
    { toast, onSaved, savedTitle: 'Sign-up gate saved' },
  );
  const state = readinessOf(v.enabled, status?.configured);

  return (
    <Section
      title="Before user created"
      actions={<StatusDot tone={readinessTone(state)} />}
      description="Allow or deny new sign-ups."
      footer={<button className="btn btn-primary" disabled={!editable || saving} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>}
    >
      <ToggleRow
        label="Enable sign-up gate"
        hint="When off, every sign-up is allowed."
        checked={v.enabled}
        disabled={!editable}
        onChange={x => patch({ enabled: x })}
      />

      {v.enabled && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="label">Email domain rule</span>
              <Select
                value={v.emailDomainMode}
                onChange={x => patch({ emailDomainMode: x as DomainMode })}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'allow', label: 'Allow only these' },
                  { value: 'block', label: 'Block these' },
                ]}
                ariaLabel="Email domain rule"
                disabled={!editable}
              />
            </label>
            <label htmlFor="sign-up-gate-domains" className="block sm:col-span-2">
              <span className="label mb-1 block">Email domains</span>
              <ListInput
                id="sign-up-gate-domains"
                disabled={!editable || v.emailDomainMode === 'off'}
                value={splitList(v.emailDomains)}
                placeholder="acme.com"
                onChange={domains => patch({ emailDomains: joinList(domains) })}
              />
            </label>
          </div>

          <WebhookFields
            url={v.webhookUrl}
            secret={v.webhookSecret}
            onUrl={webhookUrl => patch({ webhookUrl })}
            onSecret={webhookSecret => patch({ webhookSecret })}
            disabled={!editable}
            urlLabel="Verdict webhook URL"
            urlPlaceholder="https://…/hooks/signup"
            secretLabel="Webhook signing secret"
          />
          <p className="mt-1 text-[11px]" style={{ color: 'var(--text-mute)' }}>
            The webhook receives <code>{'{ event, user }'}</code> and must return <code>{'{ allow: boolean, reason? }'}</code>. When a secret is set,
            the request carries an <code>X-Signature</code> HMAC-SHA256 header over the raw body.
          </p>
        </>
      )}
    </Section>
  );
}
