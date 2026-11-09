import { VenetianMask } from 'lucide-react';
import type { useImpersonation } from '@/features/auth/hooks/useImpersonation';
import type { UserDetail } from '@/features/auth/types';
import { useCopy } from '@/shared/hooks/useCopy';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';

const DANGER = { color: 'var(--danger)', borderColor: 'var(--danger)' };

export function ImpersonationControl({
  user,
  impersonation,
  busy,
}: {
  user: UserDetail;
  impersonation: ReturnType<typeof useImpersonation>;
  busy: boolean;
}) {
  const copy = useCopy();
  const { session, start, stop } = impersonation;

  if (session) {
    return (
      <div className="space-y-2 border hairline p-2.5" style={{ borderRadius: 'var(--radius-sm)', borderColor: 'var(--warn, var(--accent))' }}>
        <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
          Impersonating {session.user.email} until {new Date(session.expiresAt).toLocaleTimeString()}. Send this
          as <span className="mono">Authorization: Bearer …</span>.
        </div>
        <div className="flex gap-2">
          <button className="btn flex-1 justify-center" onClick={() => copy(session.token, 'Session token copied')}>
            Copy token
          </button>
          <button className="btn flex-1 justify-center" disabled={stop.isPending} onClick={() => stop.mutate(session.token)} style={DANGER}>
            Stop impersonating
          </button>
        </div>
      </div>
    );
  }

  const confirmAndStart = async () => {
    const ok = await confirmDialog({
      title: `Impersonate ${user.email}?`,
      description: 'This issues a session token that acts as this user, and the action is logged.',
      confirmLabel: 'Impersonate',
      tone: 'danger',
    });
    if (ok) start.mutate();
  };

  return (
    <button
      onClick={confirmAndStart}
      disabled={busy || start.isPending || user.status !== 'active'}
      className="btn w-full justify-center"
    >
      <VenetianMask size={12} /> Impersonate…
    </button>
  );
}
