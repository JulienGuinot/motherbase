import { useState } from 'react';
import { LogOut as LogOutIcon, Monitor, Shield, ShieldOff, Trash2, Users as UsersIcon } from 'lucide-react';
import type { UpdateUserPayload } from '@/features/auth/api/users.api';
import { useImpersonation } from '@/features/auth/hooks/useImpersonation';
import { useUserDetail } from '@/features/auth/hooks/useUsers';
import type { AdminUser, UserAction, UserDetail } from '@/features/auth/types';
import { useProjectCapability } from '@/features/platform/hooks/usePlatformAccess';
import DetailDrawer, { type DrawerTab } from '@/shared/ui/DetailDrawer';
import { Avatar } from './Avatar';
import { ImpersonationControl } from './user-drawer/ImpersonationControl';
import { OverviewTab } from './user-drawer/OverviewTab';
import { SecurityTab } from './user-drawer/SecurityTab';
import { SessionsTab } from './user-drawer/SessionsTab';

type TabId = 'overview' | 'security' | 'sessions';

export function UserDrawer({
  user,
  onClose,
  onResetPassword,
  onAction,
  onDelete,
  onUpdate,
  onVerification,
  onToggleActive,
  busy,
}: {
  user: AdminUser;
  onClose: () => void;
  onResetPassword: (pwd: string) => Promise<boolean>;
  onAction: (a: UserAction) => void;
  onDelete: () => void;
  onUpdate: (payload: UpdateUserPayload) => Promise<boolean>;
  onVerification: (verified: boolean) => void;
  onToggleActive: (user: AdminUser) => void;
  busy: boolean;
}) {
  const [tab, setTab] = useState<TabId>('overview');
  const detailQ = useUserDetail(user.id);
  const detail: UserDetail = detailQ.data ?? user;
  const loaded = Boolean(detailQ.data);
  const sessionCount = detail.sessions?.length ?? 0;
  const impersonation = useImpersonation(user.id);

  // Impersonation is a credential-class action, so it sits behind the same
  // capability the console proxy enforces (`secrets.manage`). Hiding the button
  // is cosmetic: the proxy is the actual gate.
  const credentialAccess = useProjectCapability('secrets.manage');
  const profileAccess = useProjectCapability('content.write');
  const roleAccess = useProjectCapability('settings.write');
  const canManageCredentials = !busy && credentialAccess.editable;
  const canEditProfile = !busy && profileAccess.editable;
  const isAdmin = detail.role === 'ADMIN';

  const tabs: DrawerTab[] = [
    { id: 'overview', label: 'Overview', icon: UsersIcon },
    { id: 'security', label: 'Security', icon: Shield },
    { id: 'sessions', label: sessionCount ? `Sessions · ${sessionCount}` : 'Sessions', icon: Monitor },
  ];

  const footer = (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <button disabled={busy || !roleAccess.editable} onClick={() => onAction(isAdmin ? 'demote' : 'promote')} className="btn">
          {isAdmin ? <><ShieldOff size={12} /> Demote</> : <><Shield size={12} /> Promote</>}
        </button>
        <button
          // No invalidation here: a refetch fired now could read the detail
          // before the revoke lands and put the sessions back on screen. The
          // mutation's own onSuccess covers every view that shows them.
          onClick={() => onAction('revoke-sessions')}
          disabled={!canManageCredentials}
          className="btn"
        >
          <LogOutIcon size={12} /> Revoke all
        </button>
      </div>
      {credentialAccess.editable && <ImpersonationControl user={detail} impersonation={impersonation} busy={busy} />}
      <button
        onClick={onDelete}
        disabled={!canEditProfile}
        className="btn w-full justify-center"
        style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
      >
        <Trash2 size={12} /> Delete user
      </button>
    </div>
  );

  return (
    <DetailDrawer
      title={detail.email}
      subtitle={`@${detail.username || '—'}`}
      avatar={<Avatar user={detail} />}
      tabs={tabs}
      activeTab={tab}
      onTab={id => setTab(id as TabId)}
      onClose={onClose}
      footer={footer}
      width="30rem"
    >
      {detailQ.isError && (
        <div role="alert" className="mb-4 text-[12px]" style={{ color: 'var(--danger)' }}>
          Could not load user details. <button className="btn btn-ghost" onClick={() => void detailQ.refetch()}>Retry</button>
        </div>
      )}
      {/* Hidden rather than unmounted, so an unsaved profile edit survives a tab switch. */}
      <div className="space-y-5" hidden={tab !== 'overview'}>
        <OverviewTab user={detail} loading={detailQ.isLoading} loaded={loaded} canEdit={canEditProfile} onUpdate={onUpdate} />
      </div>
      {tab === 'security' && (
        <SecurityTab
          user={detail}
          loaded={loaded}
          canManageCredentials={canManageCredentials}
          canEditProfile={canEditProfile}
          onVerification={onVerification}
          onToggleActive={onToggleActive}
          onResetPassword={onResetPassword}
        />
      )}
      {tab === 'sessions' && (
        <SessionsTab
          user={detail}
          loading={detailQ.isLoading}
          failed={detailQ.isError}
          revokeDisabled={!canManageCredentials || impersonation.revokeSession.isPending}
          onRevoke={sessionId => impersonation.revokeSession.mutate(sessionId)}
        />
      )}
    </DetailDrawer>
  );
}
