'use client';

import { useState } from 'react';
import { keepPreviousData, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, LogOut as LogOutIcon, Monitor } from 'lucide-react';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { EmptyState } from '@/shared/ui/EmptyState';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { shortAgent } from '@/shared/lib/user-agent';
import { usersApi } from '@/features/auth/api/users.api';
import { invalidateFor } from '@/shared/lib/invalidate';
import { QueryState } from '@/shared/ui/QueryState';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { Pager } from '@/shared/ui/Pager';

/** Every active session across every user. Session limits and expiry are configured in Settings; this is just the list. */
export default function Sessions() {
  const toast = useToast();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const sessionsQ = useQuery({
    queryKey: ['project-sessions', { page, perPage }],
    queryFn: () => usersApi.listSessions({ page, perPage }),
    // Safe here: the rows are self-describing, so a previous page shown while
    // the next one loads is still correct (unlike the table grid).
    placeholderData: keepPreviousData,
  });

  const revoke = useMutation({
    mutationFn: (s: { userId: string; id: string }) => usersApi.revokeSession(s.userId, s.id),
    onSuccess: () => {
      // Also the drawer and the user list: the same session is shown in three
      // places.
      void invalidateFor(qc, 'session.revoked');
      toast.push({ kind: 'success', title: 'Session revoked' });
    },
    onError: e => toast.push({ kind: 'error', title: 'Revoke failed', message: getErrorMessage(e) }),
  });

  return (
    <PageShell>
      <PageHeader
        title="Sessions"
        subtitle="Every signed-in session across every user, newest first. Token and session lifetime limits are configured in Auth settings."
      />

      {/* A failed request must not read as "No active sessions": an empty list
          and an unanswered request are told apart here. */}
      <QueryState
        query={sessionsQ}
        skeletonRows={4}
        skeletonClassName=""
        errorTitle="Could not load sessions"
        // The response is a page now, so "nothing" is a total of zero rather
        // than the default empty-array test.
        isEmpty={d => d.total === 0}
        empty={
          <EmptyState mascot="sleeping" title="No active sessions" description="Nobody is signed in right now." />
        }
      >
        {data => (
        <div className="space-y-2">
          {data.sessions.map(s => (
            <div
              key={s.id}
              className="flex items-center gap-3 border hairline p-3"
              style={{ borderRadius: 'var(--radius-sm)' }}
            >
              <Monitor size={16} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">
                  {s.userEmail ?? s.userName ?? s.userId}
                  <span className="ml-1.5 text-[11px]" style={{ color: 'var(--text-mute)' }}>
                    · {shortAgent(s.userAgent)}
                  </span>
                  {s.impersonatedBy && (
                    <span className="ml-1.5 text-[10px]" style={{ color: 'var(--danger)' }}>· impersonated</span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-mute)' }}>
                  <span className="mono">{s.ipAddress || 'no ip'}</span>
                  <span className="inline-flex items-center gap-1"><Clock size={9} /> {new Date(s.createdAt).toLocaleString()}</span>
                </div>
              </div>
              <button
                onClick={async () => {
                  const who = s.userEmail ?? s.userName ?? s.userId;
                  const ok = await confirmDialog({
                    title: 'Revoke this session?',
                    description: `${who} is signed out of this device immediately.`,
                    confirmLabel: 'Revoke',
                    tone: 'danger',
                  });
                  if (ok) revoke.mutate({ userId: s.userId, id: s.id });
                }}
                disabled={revoke.isPending}
                className="btn btn-ghost shrink-0"
                style={{ color: 'var(--danger)' }}
                title="Revoke this session"
              >
                <LogOutIcon size={13} />
              </button>
            </div>
          ))}
          <Pager
            page={data.page}
            pageSize={data.perPage}
            total={data.total}
            pageCount={Math.max(1, Math.ceil(data.total / data.perPage))}
            pageSizes={[25, 50, 100]}
            onPageChange={setPage}
            onPageSizeChange={size => {
              setPerPage(size);
              setPage(1);
            }}
            label="sessions"
          />
          </div>
        )}
      </QueryState>
    </PageShell>
  );
}
