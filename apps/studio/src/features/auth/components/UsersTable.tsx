'use client';

import { CheckCircle2, Filter, LogOut as LogOutIcon, Shield, ShieldOff, Trash2, XCircle } from 'lucide-react';
import { AuthProviderBadges } from '@/features/auth/components/AuthProviderLogo';
import type { AdminUser } from '@/features/auth/types';
import { Avatar } from './Avatar';
import { SkeletonList } from '@/shared/ui/Skeleton';


function VerificationBadge({ verified }: { verified: boolean }) {
  return verified ? (
    <span className="inline-flex items-center gap-1 text-[11px]" style={{ color: 'var(--green)' }}>
      <CheckCircle2 size={11} /> Verified
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-mute)' }}>
      <XCircle size={11} /> Pending
    </span>
  );
}

export function UsersTable({
  users,
  isLoading,
  onSelect,
  onContextMenu,
  onToggleRole,
  onRevokeSessions,
  onDelete,
}: {
  users: AdminUser[];
  isLoading: boolean;
  onSelect: (user: AdminUser) => void;
  onContextMenu: (event: React.MouseEvent, user: AdminUser) => void;
  onToggleRole: (user: AdminUser) => void;
  onRevokeSessions: (user: AdminUser) => void;
  onDelete: (user: AdminUser) => void;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="overflow-auto ">
        <table className="console">
          <thead>
            <tr>
              <th>Identity</th>
              <th>Role</th>
              <th>Status</th>
              <th>Providers</th>
              <th>Email</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map(user => (
              <tr
                key={user.id}
                onClick={() => onSelect(user)}
                onContextMenu={e => onContextMenu(e, user)}
                className="cursor-pointer"
              >
                <td>
                  <div className="flex items-center gap-3">
                    <Avatar user={user} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 truncate text-[13px]">
                        {/* A guest's address is a placeholder on anonymous.invalid; the id is what identifies it. */}
                        {user.isAnonymous ? <span className="mono">{user.id}</span> : user.email}
                        {user.isAnonymous && <span className="chip">anonymous</span>}
                      </div>
                      <div className="truncate text-[11px]" style={{ color: 'var(--text-mute)' }}>
                        @{user.username || '—'}
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  <span
                    className="chip capitalize"
                    style={{
                      color: user.role === 'ADMIN' ? 'var(--accent)' : 'var(--text-dim)',
                      borderColor: user.role === 'ADMIN' ? 'var(--accent)' : undefined,
                    }}
                  >
                    {user.role.toLowerCase()}
                  </span>
                </td>
                <td>
                  <span className="text-[12px] capitalize" style={{ color: 'var(--text-dim)' }}>
                    {user.status.toLowerCase()}
                  </span>
                </td>
                <td>
                  <div className="flex gap-1">
                    <AuthProviderBadges ids={user.providers} empty="-" />
                  </div>
                </td>
                <td>
                  <VerificationBadge verified={user.emailVerified} />
                </td>
                <td onClick={e => e.stopPropagation()}>
                  <div className="flex justify-end gap-1">
                    <button
                      onClick={() => onToggleRole(user)}
                      className="btn btn-ghost"
                      title={user.role === 'ADMIN' ? 'Demote to user' : 'Promote to admin'}
                    >
                      {user.role === 'ADMIN' ? <ShieldOff size={12} /> : <Shield size={12} />}
                    </button>
                    <button onClick={() => onRevokeSessions(user)} className="btn btn-ghost" title="Revoke sessions">
                      <LogOutIcon size={12} />
                    </button>
                    <button
                      onClick={() => onDelete(user)}
                      className="btn btn-ghost"
                      title="Delete user"
                      style={{ color: 'var(--danger)' }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {isLoading && <SkeletonList rows={5} height={24} className="p-4" />}

        {!isLoading && users.length === 0 && (
          <p className="p-12 text-center text-sm" style={{ color: 'var(--text-mute)' }}>
            <Filter size={16} className="mx-auto mb-2" /> No users match your filters.
          </p>
        )}
      </div>
    </div>
  );
}
