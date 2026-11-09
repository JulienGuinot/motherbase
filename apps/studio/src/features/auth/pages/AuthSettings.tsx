import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import SettingsGroupsPanel, { type SettingsPanelItem } from '@/shared/ui/SettingsGroupsPanel';
import SettingsForm from '@/shared/ui/SettingsForm';
import { ListInput } from '@/shared/ui/ListInput';
import { joinList, phoneCodePairError, splitList } from '@/shared/lib/list-values';
import type { FieldRenderer } from '@/shared/ui/SettingsFields';

// Test numbers are one comma-separated string on the wire (phone:code pairs);
// edit them as chips so a bad pair is caught before the save round-trip.
const renderPhoneSmsField: FieldRenderer = ({ field, values, setField, editable }) =>
  field.key === 'testNumbers' ? (
    <ListInput
      id="phone-sms-test-numbers"
      mono
      disabled={!editable}
      value={splitList(String(values.testNumbers ?? ''))}
      placeholder="+15550001111:123456"
      validate={phoneCodePairError}
      onChange={pairs => setField('testNumbers', joinList(pairs))}
    />
  ) : undefined;

// Auth-owned configuration, moved off the platform Settings page. Sign-up policy,
// token lifetimes, API keys, plus the email/SMS delivery that auth flows depend on.
const ITEMS: SettingsPanelItem[] = [
  {
    key: 'auth.signup',
    label: 'Sign-up & passwords',
    description: 'Who can register, and what their password must meet. Applies immediately.',
  },
  {
    key: 'auth.tokens',
    label: 'Token expiry',
    description: 'How long access tokens and sessions last. Existing sessions keep their expiry.',
  },
  {
    key: 'auth.sessions',
    label: 'Sessions',
    description: 'Refresh, re-authentication and revocation. Session length is under Token expiry.',
  },
  {
    key: 'auth.apiKey',
    label: 'User API keys',
    description: 'Lets each user mint personal API keys through the auth API. Not the project keys, which are under Project Settings › API keys.',
  },
  {
    key: 'email.smtp',
    label: 'Email · SMTP',
    description: 'Sends every auth email. Save, then send a test to confirm it works.',
  },
  { key: 'email.templates', label: 'Email templates' },
  {
    key: 'phone.sms',
    label: 'Phone / SMS',
    render: () => (
      <SettingsForm
        group="phone.sms"
        description="Twilio, for phone sign-in and SMS second factors. Turn phone sign-in on under Sign In / Providers. Test numbers skip the provider."
        renderField={renderPhoneSmsField}
      />
    ),
  },
];

export default function AuthSettings() {
  return (
    <PageShell>
      <PageHeader title="Authentication settings" subtitle="Sign-up policy, tokens, API keys, and email / SMS delivery" />
      <SettingsGroupsPanel items={ITEMS} />
    </PageShell>
  );
}
