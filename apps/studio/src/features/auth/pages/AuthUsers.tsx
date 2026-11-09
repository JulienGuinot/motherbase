'use client';

import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { useContextMenu } from '@/shared/hooks/useContextMenu';
import { downloadCSV } from '@/shared/lib/export';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { Pager } from '@/shared/ui/Pager';
import { usersApi } from '@/features/auth/api/users.api';
import { useUsers } from '@/features/auth/hooks/useUsers';
import { useUserAdmin } from '@/features/auth/hooks/useUserAdmin';
import { USER_PAGE_SIZES, useUserFilters } from '@/features/auth/hooks/useUserFilters';
import { AuthSignInSummary } from '@/features/auth/components/AuthSignInSummary';
import { CreateUserModal } from '@/features/auth/components/CreateUserModal';
import { UserContextMenu } from '@/features/auth/components/UserContextMenu';
import { UserDrawer } from '@/features/auth/components/UserDrawer';
import { UsersTable } from '@/features/auth/components/UsersTable';
import { UsersToolbar } from '@/features/auth/components/UsersToolbar';
import type { AdminUser } from '@/features/auth/types';

const CSV_COLUMNS = ['id', 'email', 'username', 'role', 'status', 'emailVerified'];

export default function AuthUsers() {
  const toast = useToast();
  const { filters, filter, page, setPage, perPage, setPerPage } = useUserFilters();
  const usersQuery = useUsers({ page, perPage, filter });
  const total = usersQuery.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  // Deleting the last user of the last page would otherwise strand the table
  // on a page that no longer exists.
  if (usersQuery.data && page > pageCount) setPage(pageCount);
  const menu = useContextMenu<AdminUser>();

  const [selected, setSelected] = useState<AdminUser | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const users = useUserAdmin({ onInvited: () => setCreateOpen(false) });

  const remove = (user: AdminUser) => {
    users.confirmRemove(user);
    setSelected(null);
  };

  return (
    <PageShell width="wide">
      <PageHeader
        title="Authentication"
        subtitle="Users, roles, sessions and verification across the platform"
      >
        <button
          onClick={() => {
            users.clearCreatedPassword();
            setCreateOpen(true);
          }}
          className="btn btn-primary mt-4"
        >
          <UserPlus size={12} /> Add user
        </button>
      </PageHeader>

      {/* Compact, collapsible recap of the live sign-in surface: the merged
          Overview content, kept above the users table without dominating it. */}
      <AuthSignInSummary />

      {/* The export is every match, not the page on screen: a CSV is read away
          from this table, where "page 1 of 12" is not visible. */}
      <UsersToolbar
        filters={filters}
        onExport={() =>
          usersApi
            .listAll(filter)
            .then(all => downloadCSV('users.csv', CSV_COLUMNS, all))
            .catch(e => toast.push({ kind: 'error', title: 'Export failed', message: getErrorMessage(e) }))
        }
      />

      <UsersTable
        users={usersQuery.data?.users ?? []}
        isLoading={usersQuery.isLoading}
        onSelect={setSelected}
        onContextMenu={menu.onContextMenu}
        onToggleRole={users.toggleRole}
        onRevokeSessions={user => users.act(user.id, 'revoke-sessions')}
        onDelete={remove}
      />

      {total > 0 && (
        <Pager
          page={page}
          pageCount={pageCount}
          pageSize={perPage}
          total={total}
          pageSizes={USER_PAGE_SIZES}
          onPageChange={setPage}
          onPageSizeChange={setPerPage}
          label="users"
        />
      )}

      {menu.menu && (
        <UserContextMenu
          x={menu.menu.x}
          y={menu.menu.y}
          user={menu.menu.data}
          onClose={menu.close}
          onEdit={setSelected}
          onToggleRole={users.toggleRole}
          onRevokeSessions={user => users.act(user.id, 'revoke-sessions')}
          onDelete={remove}
        />
      )}

      {selected && (
        <UserDrawer
          key={selected.id}
          user={selected}
          busy={users.busy}
          onUpdate={payload => users.update(selected.id, payload)}
          onVerification={verified => users.setEmailVerified(selected.id, verified)}
          onToggleActive={users.toggleActive}
          onClose={() => setSelected(null)}
          onResetPassword={password => users.resetPassword(selected.id, password)}
          onAction={action => users.act(selected.id, action)}
          onDelete={() => remove(selected)}
        />
      )}

      {createOpen && (
        <CreateUserModal
          createdPassword={users.createdPassword}
          saving={users.creating}
          onClose={() => {
            setCreateOpen(false);
            users.clearCreatedPassword();
          }}
          onCreate={users.create}
        />
      )}
    </PageShell>
  );
}
