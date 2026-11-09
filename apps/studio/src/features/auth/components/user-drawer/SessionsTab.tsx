import { Clock, LogOut as LogOutIcon, Monitor } from 'lucide-react';
import type { UserDetail } from '@/features/auth/types';
import { shortAgent } from '@/shared/lib/user-agent';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { EmptyState } from '@/shared/ui/EmptyState';
import { SkeletonList } from '@/shared/ui/Skeleton';

type UserSession = NonNullable<UserDetail['sessions']>[number];

function SessionRow({ session, onRevoke, revokeDisabled }: { session: UserSession; onRevoke: () => void; revokeDisabled: boolean }) {
  return (
    <div className="flex items-center gap-3 border hairline p-3" style={{ borderRadius: 'var(--radius-sm)' }}>
      <Monitor size={16} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px]">
          {shortAgent(session.userAgent)}
          {session.impersonatedBy && <span className="ml-1.5 text-[10px]" style={{ color: 'var(--danger)' }}>· impersonated</span>}
        </div>
        <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-mute)' }}>
          <span className="mono">{session.ipAddress || 'no ip'}</span>
          <span className="inline-flex items-center gap-1"><Clock size={9} /> {new Date(session.createdAt).toLocaleString()}</span>
        </div>
      </div>
      <button
        onClick={onRevoke}
        disabled={revokeDisabled}
        className="btn btn-ghost shrink-0"
        style={{ color: 'var(--danger)' }}
        title="Revoke this session"
      >
        <LogOutIcon size={13} />
      </button>
    </div>
  );
}

export function SessionsTab({
  user,
  loading,
  failed,
  revokeDisabled,
  onRevoke,
}: {
  user: UserDetail;
  loading: boolean;
  failed: boolean;
  revokeDisabled: boolean;
  onRevoke: (sessionId: string) => void;
}) {
  const sessions = user.sessions ?? [];

  const confirmAndRevoke = async (sessionId: string) => {
    const ok = await confirmDialog({
      title: 'Revoke this session?',
      description: `${user.email} is signed out of this device immediately.`,
      confirmLabel: 'Revoke',
      tone: 'danger',
    });
    if (ok) onRevoke(sessionId);
  };

  return (
    <div className="space-y-2">
      {loading && <SkeletonList rows={3} height={48} />}
      {!loading && !failed && sessions.length === 0 && (
        <EmptyState title="No active sessions" description="This user is not signed in anywhere right now." />
      )}
      {sessions.map(s => (
        <SessionRow key={s.id} session={s} onRevoke={() => void confirmAndRevoke(s.id)} revokeDisabled={revokeDisabled} />
      ))}
    </div>
  );
}
