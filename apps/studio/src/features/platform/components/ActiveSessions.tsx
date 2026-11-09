import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, LogOut, RefreshCw } from 'lucide-react';
import { consoleSessionsApi, type ConsoleSession } from '@/features/platform/api/console-sessions.api';
import { auth } from '@/shared/lib/auth';
import { useToast } from '@/shared/lib/toast';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { Section } from '@/shared/ui/Section';

const QUERY_KEY = ['console-sessions'] as const;

function currentSessionToken(): string | null {
  const access = auth.getAccess();
  if (!access) return null;
  try {
    return decodeURIComponent(access).split('.')[0] || null;
  } catch {
    return access.split('.')[0] || null;
  }
}

function sessionLabel(session: ConsoleSession): string {
  return session.userAgent?.trim() || 'Unknown client';
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

export function ActiveSessions() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const currentToken = currentSessionToken();
  const sessionsQuery = useQuery({ queryKey: QUERY_KEY, queryFn: consoleSessionsApi.list });

  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  const revoke = useMutation({
    mutationFn: consoleSessionsApi.revoke,
    onSuccess: () => {
      refresh();
      toast.push({ kind: 'success', title: 'Session revoked' });
    },
    onError: () => toast.push({ kind: 'error', title: 'Could not revoke session' }),
  });
  const revokeOthers = useMutation({
    mutationFn: consoleSessionsApi.revokeOthers,
    onSuccess: () => {
      refresh();
      toast.push({ kind: 'success', title: 'Other sessions revoked' });
    },
    onError: () => toast.push({ kind: 'error', title: 'Could not revoke sessions' }),
  });

  const sessions = sessionsQuery.data ?? [];
  const otherSessionCount = sessions.filter(session => session.token !== currentToken).length;

  return (
    <Section
      title="Active console sessions"
      titleId="active-sessions-title"
      description="Signed-in devices. Revoke any you no longer recognize."
      actions={
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => refresh()}
          disabled={sessionsQuery.isFetching}
          title="Refresh sessions"
          aria-label="Refresh sessions"
        >
          <RefreshCw size={12} className={sessionsQuery.isFetching ? 'animate-spin' : undefined} />
        </button>
      }
      flush
      footer={
        <button
          type="button"
          className="btn"
          onClick={async () => {
            const ok = await confirmDialog({
              title: 'Revoke other sessions?',
              description: `${otherSessionCount} other signed-in ${otherSessionCount === 1 ? 'device is' : 'devices are'} signed out immediately. This session stays signed in.`,
              confirmLabel: 'Revoke',
              tone: 'danger',
            });
            if (ok) revokeOthers.mutate();
          }}
          disabled={otherSessionCount === 0 || revokeOthers.isPending}
        >
          <LogOut size={12} />
          Revoke other sessions{otherSessionCount > 0 ? ` (${otherSessionCount})` : ''}
        </button>
      }
    >
      {sessionsQuery.isLoading ? (
        <div className="space-y-2 p-5">
          <div className="shimmer h-12 rounded-md" />
          <div className="shimmer h-12 rounded-md" />
        </div>
      ) : sessionsQuery.isError ? (
        <p className="px-5 py-4 text-[12px]" style={{ color: 'var(--red)' }}>
          Sessions could not be loaded.
        </p>
      ) : sessions.length === 0 ? (
        <p className="px-5 py-4 text-[12px]" style={{ color: 'var(--text-mute)' }}>
          No active sessions.
        </p>
      ) : (
        <ul>
          {sessions.map(session => {
            const isCurrent = session.token === currentToken;
            return (
              <li key={session.id} className="flex items-center gap-3 border-t hairline px-5 py-3 first:border-t-0">
                <Laptop size={15} className="shrink-0" style={{ color: 'var(--text-mute)' }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13px]">
                    <span className="truncate" title={sessionLabel(session)}>{sessionLabel(session)}</span>
                    {isCurrent && <span className="chip">Current</span>}
                  </div>
                  <div className="mt-0.5 text-[11px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
                    {session.ipAddress || 'Unknown IP'} · expires {formatDate(session.expiresAt)}
                  </div>
                </div>
                {!isCurrent && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={async () => {
                      const ok = await confirmDialog({
                        title: 'Revoke this session?',
                        description: `${sessionLabel(session)} is signed out immediately.`,
                        confirmLabel: 'Revoke',
                        tone: 'danger',
                      });
                      if (ok) revoke.mutate(session.token);
                    }}
                    disabled={revoke.isPending}
                  >
                    Revoke
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
