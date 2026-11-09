import { getErrorMessage } from '@/shared/lib/errors';
import type React from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Users as UsersIcon, UserPlus, Pencil, Trash2, Shield, ShieldCheck, LogOut } from 'lucide-react';
import { isProjectScopedRole, platform, type PlatformRole, type PlatformUser } from '@/shared/lib/api';
import { useToast } from '@/shared/lib/toast';
import { UserFormModal } from '@/features/platform/components/UserFormModal';
import { usePlatformMe } from '@/features/platform/hooks/usePlatformAccess';
import { EmptyState } from '@/shared/ui/EmptyState';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';

const ROLE_META: Record<
  PlatformRole,
  { label: string; color: string; icon: React.ComponentType<{ size?: number }> | null }
> = {
  owner: { label: 'Owner', color: 'var(--amber)', icon: ShieldCheck },
  admin: { label: 'Admin', color: 'var(--accent)', icon: Shield },
  developer: { label: 'Developer', color: 'var(--green)', icon: null },
  read_only: { label: 'Read-only', color: 'var(--text-dim)', icon: null },
  member: { label: 'Developer (legacy)', color: 'var(--text-dim)', icon: null },
};

function RoleBadge({ role }: { role: PlatformRole }) {
  const meta = ROLE_META[role] ?? ROLE_META.member;
  const Icon = meta.icon;
  return (
    <span className="chip" style={{ color: meta.color, borderColor: role === 'member' ? undefined : meta.color }}>
      {Icon ? <Icon size={10} /> : null}
      {meta.label}
    </span>
  );
}

interface ProjectRef {
  name: string;
}

export function UsersTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const meQ = usePlatformMe();
  const [editing, setEditing] = useState<PlatformUser | null>(null);
  const [creating, setCreating] = useState(false);

  const usersQ = useQuery({ queryKey: ['platform-users'], queryFn: platform.users.list });
  const projectsQ = useQuery({ queryKey: ['platform-projects'], queryFn: () => platform.list() });
  const projectNames = ((projectsQ.data ?? []) as ProjectRef[]).map(p => p.name);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['platform-users'] });

  const create = useMutation({
    mutationFn: (body: { email: string; password: string; role: PlatformRole; projects?: string[] }) =>
      platform.users.create(body),
    onSuccess: () => {
      invalidate();
      setCreating(false);
      toast.push({ kind: 'success', title: 'User created' });
    },
    onError: e => toast.push({ kind: 'error', title: 'Create failed', message: getErrorMessage(e) }),
  });

  const update = useMutation({
    mutationFn: (args: {
      id: string;
      patch: { role?: PlatformRole; projects?: string[]; disabled?: boolean; password?: string };
    }) => platform.users.update(args.id, args.patch),
    onSuccess: () => {
      invalidate();
      setEditing(null);
      toast.push({ kind: 'success', title: 'User updated' });
    },
    onError: e => toast.push({ kind: 'error', title: 'Update failed', message: getErrorMessage(e) }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => platform.users.remove(id),
    onSuccess: () => {
      invalidate();
      toast.push({ kind: 'success', title: 'User deleted' });
    },
    onError: e => toast.push({ kind: 'error', title: 'Delete failed', message: getErrorMessage(e) }),
  });

  const revokeSessions = useMutation({
    mutationFn: (id: string) => platform.users.revokeSessions(id),
    onSuccess: () => toast.push({ kind: 'success', title: 'Sessions revoked' }),
    onError: e => toast.push({ kind: 'error', title: 'Revocation failed', message: getErrorMessage(e) }),
  });

  const users = usersQ.data ?? [];

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-5">
        <span className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--text-dim)' }}>
          <UsersIcon size={13} style={{ color: 'var(--text-mute)' }} /> Console users
        </span>
        <button onClick={() => setCreating(true)} className="btn btn-primary">
          <UserPlus size={12} /> Add user
        </button>
      </div>
      <p className="px-5 pt-2 text-[12px]" style={{ color: 'var(--text-mute)' }}>
        Owners and admins reach every project. Developers and read-only users are scoped to assigned projects.
      </p>

      {usersQ.isLoading ? (
        <div className="p-5 space-y-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="shimmer h-6" />
          ))}
        </div>
      ) : users.length === 0 ? (
        <EmptyState mascot="happy" title="No console users" description="Invite an operator to give them access to this platform console." />
      ) : (
        <div className="overflow-auto pt-3">
          <table className="console">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Projects</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id}>
                  <td className="text-[13px]" style={{ fontWeight: 500 }}>
                    {u.email}
                  </td>
                  <td>
                    <RoleBadge role={u.role} />
                  </td>
                  <td
                    className="text-[12px]"
                    style={{ color: 'var(--text-dim)' }}
                    title={isProjectScopedRole(u.role) ? u.projects.join(', ') || 'No projects assigned' : undefined}
                  >
                    {isProjectScopedRole(u.role)
                      ? `${u.projects.length} project${u.projects.length !== 1 ? 's' : ''}`
                      : 'All projects'}
                  </td>
                  <td>
                    {u.disabled ? (
                      <span
                        className="inline-flex items-center gap-1.5 text-[12px]"
                        style={{ color: 'var(--text-mute)' }}
                      >
                        <span className="dot" style={{ background: 'var(--text-mute)' }} /> Disabled
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--green)' }}>
                        <span className="dot" style={{ background: 'var(--green)' }} /> Active
                      </span>
                    )}
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    <div className="flex justify-end gap-1">
                      {u.id !== meQ.data?.id && (
                        <button
                          onClick={async () => {
                            if (await confirmDialog({
                              title: 'Revoke every active session?',
                              description: `${u.email} is signed out everywhere and has to authenticate again.`,
                              confirmLabel: 'Revoke sessions',
                              tone: 'danger',
                            })) {
                              revokeSessions.mutate(u.id);
                            }
                          }}
                          className="btn btn-ghost"
                          title="Revoke all sessions"
                          disabled={revokeSessions.isPending}
                        >
                          <LogOut size={12} />
                        </button>
                      )}
                      <button onClick={() => setEditing(u)} className="btn btn-ghost" title="Edit user">
                        <Pencil size={12} />
                      </button>
                      <button
                        onClick={async () => {
                          if (await confirmDialog({ title: `Delete ${u.email}?`, description: 'The account and every session it holds are removed.', confirmLabel: 'Delete user', tone: 'danger' })) remove.mutate(u.id);
                        }}
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
        </div>
      )}

      {creating && (
        <UserFormModal
          projects={projectNames}
          saving={create.isPending}
          onClose={() => setCreating(false)}
          onSubmit={payload =>
            create.mutate({
              email: payload.email,
              password: payload.password ?? '',
              role: payload.role,
              projects: isProjectScopedRole(payload.role) ? payload.projects : undefined,
            })
          }
        />
      )}

      {editing && (
        <UserFormModal
          user={editing}
          projects={projectNames}
          saving={update.isPending}
          onClose={() => setEditing(null)}
          onSubmit={payload =>
            update.mutate({
              id: editing.id,
              patch: {
                role: payload.role,
                disabled: payload.disabled,
                projects: isProjectScopedRole(payload.role) ? payload.projects : undefined,
                password: payload.password || undefined,
              },
            })
          }
        />
      )}
    </div>
  );
}
