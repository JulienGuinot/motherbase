'use client';

import { useSettingsDraft, type AuthPanelProps } from '@/features/auth/lib/settings-panel';
import { Section } from '@/shared/ui/Section';
import { ToggleRow } from '@/shared/ui/Toggle';
import { StatusDot } from '@/shared/ui/Badge';
import Select from '@/shared/ui/Select';
import { readinessOf, readinessTone } from '@/features/auth/lib/readiness';

/** How one-time codes reach the user, on top of the TOTP authenticator. */
type Channel = 'off' | 'email' | 'sms';

export function MfaPanel({ initial, status, onSaved, toast, editable }: AuthPanelProps) {
  const { v, patch, saving, save } = useSettingsDraft(
    'auth.twoFactor',
    {
      enabled: !!initial.enabled,
      issuer: String(initial.issuer ?? ''),
      totpDigits: Number(initial.totpDigits ?? 6),
      totpPeriod: Number(initial.totpPeriod ?? 30),
      otpChannel: (initial.otpChannel as Channel) ?? 'off',
      otpDigits: Number(initial.otpDigits ?? 6),
      otpPeriodMinutes: Number(initial.otpPeriodMinutes ?? 3),
      backupCodeCount: Number(initial.backupCodeCount ?? 10),
      backupCodeLength: Number(initial.backupCodeLength ?? 10),
      trustDeviceDays: Number(initial.trustDeviceDays ?? 30),
    },
    { toast, onSaved, savedTitle: 'Two-factor saved' },
  );
  const state = readinessOf(v.enabled, status?.configured);

  return (
    <Section
      title="Two-factor authentication"
      actions={<StatusDot tone={readinessTone(state)} />}
      description="Time-based codes, email/SMS codes, and backup codes."
      footer={<button className="btn btn-primary" disabled={!editable || saving} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>}
    >
      <ToggleRow
        label="Enable two-factor"
        hint="Let users add a second factor. It stays opt-in per user."
        checked={v.enabled}
        disabled={!editable}
        onChange={x => patch({ enabled: x })}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="label">Issuer (shown in authenticator apps)</span>
          <input disabled={!editable} className="input mt-1 w-full" value={v.issuer} placeholder="MyApp" onChange={e => patch({ issuer: e.target.value })} />
        </label>
        <label className="block">
          <span className="label mr-2">TOTP digits</span>
          <Select
            value={String(v.totpDigits)}
            onChange={x => patch({ totpDigits: Number(x) })}
            options={[{ value: '6', label: '6 digits' }, { value: '8', label: '8 digits' }]}
            ariaLabel="TOTP digits"
            disabled={!editable}
          />
        </label>
        <label className="block">
          <span className="label">TOTP period (seconds)</span>
          <input disabled={!editable} className="input mt-1 w-full" type="number" min={15} value={v.totpPeriod} onChange={e => patch({ totpPeriod: Number(e.target.value) })} />
        </label>
      </div>

      <div className="mt-2 grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="label">One-time code channel</span>
          <Select
            value={v.otpChannel}
            onChange={x => patch({ otpChannel: x as Channel })}
            options={[
              { value: 'off', label: 'Off (TOTP only)' },
              { value: 'email', label: 'Email' },
              { value: 'sms', label: 'SMS (needs phone)' },
            ]}
            ariaLabel="OTP channel"
            disabled={!editable}
          />
        </label>
        <label className="block">
          <span className="label">OTP digits</span>
          <input className="input mt-1 w-full" type="number" min={4} max={10} disabled={!editable || v.otpChannel === 'off'} value={v.otpDigits} onChange={e => patch({ otpDigits: Number(e.target.value) })} />
        </label>
        <label className="block">
          <span className="label">OTP validity (minutes)</span>
          <input className="input mt-1 w-full" type="number" min={1} disabled={!editable || v.otpChannel === 'off'} value={v.otpPeriodMinutes} onChange={e => patch({ otpPeriodMinutes: Number(e.target.value) })} />
        </label>
      </div>
      {v.otpChannel === 'sms' && state === 'warn' && (
        <p className="mt-1 text-[11px]" style={{ color: 'var(--amber)' }}>
          SMS channel needs Twilio credentials: configure them in Authentication › Settings › Phone / SMS.
        </p>
      )}

      <div className="mt-2 grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="label">Backup codes count</span>
          <input disabled={!editable} className="input mt-1 w-full" type="number" min={1} max={50} value={v.backupCodeCount} onChange={e => patch({ backupCodeCount: Number(e.target.value) })} />
        </label>
        <label className="block">
          <span className="label">Backup code length</span>
          <input disabled={!editable} className="input mt-1 w-full" type="number" min={6} max={32} value={v.backupCodeLength} onChange={e => patch({ backupCodeLength: Number(e.target.value) })} />
        </label>
        <label className="block">
          <span className="label">Trust device (days)</span>
          <input disabled={!editable} className="input mt-1 w-full" type="number" min={0} value={v.trustDeviceDays} onChange={e => patch({ trustDeviceDays: Number(e.target.value) })} />
        </label>
      </div>
    </Section>
  );
}
