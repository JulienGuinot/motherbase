import { ServerTab } from '@/features/platform/components/ServerTab';
import { AccountTab } from '@/features/platform/components/AccountTab';
import { MonitorTab } from '@/features/platform/components/MonitorTab';
import { OrganizationsPanel, OrgGeneralPanel, OrgMembersPanel } from '@/features/platform/components/OrgPanels';
import OrgAiTab from '@/features/platform/components/OrgAiTab';
import { AuditLogTab } from '@/features/platform/components/AuditLogTab';
import { ProjectDefaults } from '@/features/platform/components/ProjectDefaults';
import { hasPlatformCapability, usePlatformMe } from '@/features/platform/hooks/usePlatformAccess';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { RouteLoading } from '@/shared/ui/RouteLoading';
import SettingsGroupsPanel, { type SettingsPanelItem } from '@/shared/ui/SettingsGroupsPanel';

// Org > Settings: the active organization, the console itself, and your account,
// laid out like a project's settings so the two consoles read as one. Sections
// a role cannot use are left out rather than shown and refused: a developer
// scoped to one project has no business seeing the server's configuration, nor
// a list of every organization on it.
export default function OrgSettings() {
  const meQuery = usePlatformMe();
  if (meQuery.isPending) return <RouteLoading />;

  const me = meQuery.data;
  const consoleAdmin = me?.role === 'owner' || me?.role === 'admin';
  const canManageServer = hasPlatformCapability(me, 'users.manage');

  const items: SettingsPanelItem[] = [
    { key: 'general', label: 'General', render: () => <OrgGeneralPanel /> },
    { key: 'members', label: 'Members', render: () => <OrgMembersPanel /> },
    { key: 'ai', label: 'AI assistant', render: () => <OrgAiTab /> },
    ...(consoleAdmin ? [{ key: 'organizations', label: 'All organizations', render: () => <OrganizationsPanel /> }] : []),
    { key: 'account', label: 'Your account', render: () => <AccountTab /> },
    ...(canManageServer
      ? [
          { key: 'server', label: 'Server', render: () => <ServerTab /> },
          { key: 'defaults', label: 'New-project defaults', render: () => <ProjectDefaults /> },
        ]
      : []),
    ...(consoleAdmin ? [{ key: 'health', label: 'System health', render: () => <MonitorTab /> }] : []),
    ...(hasPlatformCapability(me, 'audit.read') ? [{ key: 'audit', label: 'Audit log', render: () => <AuditLogTab /> }] : []),
  ];

  return (
    <PageShell>
      <PageHeader
        size="md"
        title="Org settings"
        subtitle="The organization, its members and AI key, your account, and the console server."
      />
      <SettingsGroupsPanel items={items} />
    </PageShell>
  );
}
