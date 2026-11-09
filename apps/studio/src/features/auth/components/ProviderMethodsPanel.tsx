import { useToast } from '@/shared/lib/toast';
import { useSettingsDraft } from '@/features/auth/lib/settings-panel';
import { Section } from '@/shared/ui/Section';
import { ToggleRow } from '@/shared/ui/Toggle';
import { SettingsAccessNotice } from '@/shared/ui/SettingsAccessNotice';

export function ProviderMethodsPanel({
  initial,
  onSaved,
  editable,
  accessPending,
}: {
  initial: Record<string, unknown>;
  onSaved: () => void;
  editable: boolean;
  accessPending: boolean;
}) {
  const toast = useToast();
  const { v, patch, saving, save } = useSettingsDraft(
    'auth.methods',
    {
      emailPassword: !!initial.emailPassword,
      magicLink: !!initial.magicLink,
      emailOTP: !!initial.emailOTP,
      anonymous: !!initial.anonymous,
    },
    { toast, onSaved, savedTitle: 'Sign-in methods saved' },
  );
  const dirty = (Object.keys(v) as Array<keyof typeof v>).some(key => v[key] !== !!initial[key]);

  return (
    <Section
      title="Sign-in methods"
      description="Native authentication that needs no third party."
      footer={<button className="btn btn-primary" disabled={!editable || !dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>}
    >
      <ToggleRow disabled={!editable} label="Email &amp; password" hint="Classic credentials with the project's argon2 hashing." checked={v.emailPassword} onChange={x => patch({ emailPassword: x })} />
      <ToggleRow disabled={!editable} label="Magic link" hint="Passwordless sign-in via a one-time email link." checked={v.magicLink} onChange={x => patch({ magicLink: x })} />
      <ToggleRow disabled={!editable} label="Email OTP" hint="One-time numeric codes sent by email." checked={v.emailOTP} onChange={x => patch({ emailOTP: x })} />
      <ToggleRow
        disabled={!editable}
        label="Allow anonymous sign-ins"
        hint="signInAnonymously() creates a guest user. Policies see it as authenticated with is_anonymous = true; pair it with CAPTCHA to keep bots from filling the users table."
        checked={v.anonymous}
        onChange={x => patch({ anonymous: x })}
      />
      <SettingsAccessNotice editable={editable} pending={accessPending} />
    </Section>
  );
}
