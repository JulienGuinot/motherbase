import { getErrorMessage } from '@/shared/lib/errors';
import { useState } from 'react';
import Link from 'next/link';
import { useToast } from '@/shared/lib/toast';
import { saveSettings, type AuthStatusItem } from '@/shared/lib/settings';
import { projectPath } from '@/shared/lib/project';
import { Section } from '@/shared/ui/Section';
import { ToggleRow } from '@/shared/ui/Toggle';
import { StatusDot } from '@/shared/ui/Badge';
import { readinessOf, readinessTone } from '@/features/auth/lib/readiness';
import { SettingsAccessNotice } from '@/shared/ui/SettingsAccessNotice';

// Phone (SMS) sign-in: the auth-side behaviour only (auth.phoneOtp). The Twilio
// transport (phone.sms) is shared with SMS second factors, so it lives with the
// other delivery transports under Authentication > Settings, the way SMTP does
// for email. This toggle is the only switch: the transport has none of its own.
export function ProviderPhonePanel({
  otp,
  status,
  onSaved,
  editable,
  accessPending,
}: {
  otp: Record<string, unknown>;
  status?: AuthStatusItem;
  onSaved: () => void;
  editable: boolean;
  accessPending: boolean;
}) {
  const toast = useToast();
  const [v, setV] = useState({
    enabled: !!otp.enabled,
    otpLength: Number(otp.otpLength ?? 6),
    expiresIn: Number(otp.expiresIn ?? 300),
    signUpOnVerification: otp.signUpOnVerification !== false,
  });
  const [saving, setSaving] = useState(false);

  const state = readinessOf(v.enabled, status?.configured);
  // The server's verdict: the auth token is a secret and never reaches the console.
  const transportReady = !!status?.configured;

  function patch(p: Partial<typeof v>) {
    setV(s => ({ ...s, ...p }));
  }

  async function save() {
    setSaving(true);
    try {
      await saveSettings('auth.phoneOtp', v);
      toast.push({ kind: 'success', title: 'Phone sign-in saved' });
      onSaved();
    } catch (e) {
      toast.push({ kind: 'error', title: 'Save failed', message: getErrorMessage(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="Phone (SMS)"
      actions={<StatusDot tone={readinessTone(state)} />}
      description="Sign-in and sign-up by phone number, with a one-time code sent by SMS."
      footer={
        <button className="btn btn-primary" disabled={!editable || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      }
    >
      <ToggleRow
        label="Enable phone sign-in"
        hint="Let users request an SMS code to sign in or create an account."
        checked={v.enabled}
        disabled={!editable}
        onChange={x => patch({ enabled: x })}
      />

      <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
        {transportReady ? 'Codes are sent through Twilio, set up' : 'No SMS transport yet. Set up Twilio'} under{' '}
        <Link href={projectPath('/auth/settings#phone.sms')} className="underline" style={{ color: 'var(--accent)' }}>
          Authentication › Settings › Phone / SMS
        </Link>
        , where test numbers and the test message are too.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label">OTP length</span>
          <input disabled={!editable} className="input mt-1 w-full" type="number" min={4} max={10} value={v.otpLength} onChange={e => patch({ otpLength: Number(e.target.value) })} />
        </label>
        <label className="block">
          <span className="label">OTP expiry (seconds)</span>
          <input disabled={!editable} className="input mt-1 w-full" type="number" min={30} value={v.expiresIn} onChange={e => patch({ expiresIn: Number(e.target.value) })} />
        </label>
      </div>

      <ToggleRow
        label="Create account on first verified number"
        hint="Unknown numbers become a new user once the code is verified."
        checked={v.signUpOnVerification}
        disabled={!editable}
        onChange={x => patch({ signUpOnVerification: x })}
      />
      <SettingsAccessNotice editable={editable} pending={accessPending} />
    </Section>
  );
}
