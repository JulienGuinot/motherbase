'use client';

import { Copy, KeyRound, LogOut as LogOutIcon, Shield, ShieldOff, Trash2, Users as UsersIcon } from 'lucide-react';
import { ContextMenu } from '@/shared/ui/ContextMenu';
import { useCopy } from '@/shared/hooks/useCopy';
import type { AdminUser } from '@/features/auth/types';

/** Right-click actions on a row. Same operations as the row buttons and drawer. */
export function UserContextMenu({
  x,
  y,
  user,
  onClose,
  onEdit,
  onToggleRole,
  onRevokeSessions,
  onDelete,
}: {
  x: number;
  y: number;
  user: AdminUser;
  onClose: () => void;
  onEdit: (user: AdminUser) => void;
  onToggleRole: (user: AdminUser) => void;
  onRevokeSessions: (user: AdminUser) => void;
  onDelete: (user: AdminUser) => void;
}) {
  const copy = useCopy();
  const isAdmin = user.role === 'ADMIN';

  return (
    <ContextMenu
      x={x}
      y={y}
      onClose={onClose}
      items={[
        { label: 'Edit user', icon: <UsersIcon size={13} />, action: () => onEdit(user) },
        { label: 'Copy user ID', icon: <Copy size={13} />, action: () => copy(user.id, 'ID copied') },
        { type: 'separator' as const },
        {
          label: isAdmin ? 'Demote to user' : 'Promote to admin',
          icon: isAdmin ? <ShieldOff size={13} /> : <Shield size={13} />,
          action: () => onToggleRole(user),
        },
        { label: 'Revoke sessions', icon: <LogOutIcon size={13} />, action: () => onRevokeSessions(user) },
        { type: 'separator' as const },
        { label: 'Reset password…', icon: <KeyRound size={13} />, action: () => onEdit(user) },
        { type: 'separator' as const },
        { label: 'Delete user…', icon: <Trash2 size={13} />, action: () => onDelete(user) },
      ]}
    />
  );
}
