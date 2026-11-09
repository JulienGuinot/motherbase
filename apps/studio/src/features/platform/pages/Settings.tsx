import SettingsForm from '@/shared/ui/SettingsForm';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import SettingsGroupsPanel, { type SettingsPanelItem } from '@/shared/ui/SettingsGroupsPanel';
import { BackendControl } from '@/features/platform/components/BackendControl';
import { BackupsSettings } from '@/features/platform/components/BackupsSettings';
import { GeneralSettings } from '@/features/platform/components/GeneralSettings';
import ApiKeysPanel from '@/features/projects/components/ApiKeysPanel';
import { PushTestPanel } from '@/features/platform/components/PushTestPanel';
import JwtKeysPanel from '@/features/projects/components/JwtKeysPanel';
import DatabaseAccessPanel from '@/features/projects/components/DatabaseAccessPanel';
import LogDrainsPanel from '@/features/projects/components/LogDrainsPanel';
import CustomDomainsPanel from '@/features/projects/components/CustomDomainsPanel';
import { ListInput } from '@/shared/ui/ListInput';
import { joinList, originError, splitList } from '@/shared/lib/list-values';
import type { FieldRenderer } from '@/shared/ui/SettingsFields';

// The allowlist is one comma-separated string on the wire; edit it as chips.
// `*` is a legal entry (dev-only), so the validator permits the wildcard.
const renderCorsField: FieldRenderer = ({ field, values, setField, editable }) =>
  field.key === 'origins' ? (
    <ListInput
      id="server-cors-origins"
      mono
      disabled={!editable}
      value={splitList(String(values.origins ?? ''))}
      placeholder="https://app.example.com"
      validate={value => originError(value, { allowWildcard: true })}
      onChange={origins => setField('origins', joinList(origins))}
    />
  ) : undefined;

// Settings that span the whole project. A setting that belongs to one product
// lives on that product's page and only there (Auth, Database, Storage, Realtime,
// Logs, API): an earlier layout rendered CORS, log retention and the Twilio
// credentials on two screens each, which left the operator wondering which one won.
const ITEMS: SettingsPanelItem[] = [
  { key: 'general', label: 'General', render: () => <GeneralSettings /> },
  { key: 'api-keys', label: 'API keys', render: () => <ApiKeysPanel /> },
  { key: 'jwt-keys', label: 'JWT keys', render: () => <JwtKeysPanel /> },
  { key: 'database-access', label: 'Database access', render: () => <DatabaseAccessPanel /> },
  { key: 'log-drains', label: 'Log drains', render: () => <LogDrainsPanel /> },
  { key: 'backend', label: 'Backend control', render: () => <BackendControl /> },
  { key: 'backups', label: 'Backups / restore', render: () => <BackupsSettings /> },
  {
    key: 'security',
    label: 'Security',
    render: () => (
      <div className="space-y-6">
        <SettingsForm
          group="server.cors"
          description="Browser origins allowed to call the API. Leave blank to allow all (dev only)."
          renderField={renderCorsField}
        />
        <SettingsForm
          group="security.rateLimit"
          description="Requests per client within the window, for every route. Auth also has per-kind limits under Authentication › Rate Limits."
        />
        <SettingsForm group="security.rateLimitRules" />
      </div>
    ),
  },
  {
    key: 'data.retention',
    label: 'Data · Retention',
    description: 'Prunes webhook deliveries and edge-function logs on a schedule.',
  },
  {
    key: 'push',
    label: 'Push notifications',
    render: () => (
      <div className="space-y-6">
        <SettingsForm group="push.fcm" />
        <SettingsForm group="push.apns" />
        <PushTestPanel />
      </div>
    ),
  },
  { key: 'custom-domains', label: 'Custom domains', render: () => <CustomDomainsPanel /> },
];

export default function Settings() {
  return (
    <PageShell>
      <PageHeader
        size="md"
        title="Project Settings"
        subtitle="Settings that span the whole project: keys, network access, backups, security, retention and push delivery. Product settings are on each product's own page."
      />
      <SettingsGroupsPanel items={ITEMS} />
    </PageShell>
  );
}
