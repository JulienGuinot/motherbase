'use client';

import { useState } from 'react';
import { Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { QueryState } from '@/shared/ui/QueryState';
import { Badge } from '@/shared/ui/Badge';
import { Checkbox } from '@/shared/ui/Field';
import { WriteButton } from '@/shared/ui/WriteButton';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { catalogApi, type DatabaseRole, type RoleWrite } from '@/features/database/api/catalog.api';
import { useCatalogWrite, useDatabaseRoles } from '@/features/database/hooks/useCatalog';
import { RoleModal } from '@/features/database/components/RoleModal';

// A role can hold a login password, so the console rates every role write as
// credential management (see adminProxyCapability).
const CAPABILITY = 'secrets.manage';

const FLAGS: Array<[keyof DatabaseRole, string]> = [
  ['isSuperuser', 'superuser'],
  ['canCreateDb', 'createdb'],
  ['canCreateRole', 'createrole'],
  ['canReplicate', 'replication'],
  ['canBypassRls', 'bypassrls'],
];

function RoleRow({ role, onEdit, onDrop }: { role: DatabaseRole; onEdit: () => void; onDrop: () => void }) {
  return (
    <tr>
      <td>
        <div className="flex items-center gap-2">
          {role.reserved && <span title={role.reserved} style={{ color: 'var(--text-mute)' }}><Lock size={11} /></span>}
          <span className="mono text-[12.5px]">{role.name}</span>
        </div>
        {role.reserved && <div className="text-[11px]" style={{ color: 'var(--text-mute)' }}>{role.reserved}</div>}
      </td>
      <td>{role.canLogin ? <Badge tone="success">login</Badge> : <Badge>group</Badge>}</td>
      <td>
        <div className="flex flex-wrap gap-1">
          {FLAGS.filter(([key]) => role[key]).map(([key, label]) => (
            <Badge key={key} tone={key === 'isSuperuser' || key === 'canBypassRls' ? 'warn' : 'neutral'}>{label}</Badge>
          ))}
        </div>
      </td>
      <td className="text-right tabular-nums">
        {role.activeConnections}
        <span style={{ color: 'var(--text-mute)' }}> / {role.connectionLimit < 0 ? '∞' : role.connectionLimit}</span>
      </td>
      <td className="mono text-[11px]" style={{ color: 'var(--text-mute)' }}>{role.memberOf.join(', ')}</td>
      <td className="text-right">
        {!role.reserved && (
          <div className="flex justify-end gap-1">
            <WriteButton capability={CAPABILITY} className="btn btn-ghost" title="Edit role" onClick={onEdit}><Pencil size={12} /></WriteButton>
            <WriteButton capability={CAPABILITY} className="btn btn-ghost" style={{ color: 'var(--danger)' }} title="Drop role" onClick={onDrop}>
              <Trash2 size={12} />
            </WriteButton>
          </div>
        )}
      </td>
    </tr>
  );
}

/**
 * Database > Roles. Platform roles (postgres, anon, authenticated,
 * service_role, the role the server connects as) are listed but locked: the
 * server refuses to change them, and the page does not offer to.
 */
export default function Roles() {
  const rolesQuery = useDatabaseRoles();
  const [editing, setEditing] = useState<DatabaseRole | 'new' | null>(null);
  const [showPredefined, setShowPredefined] = useState(false);

  const save = useCatalogWrite({
    run: async ({ original, body }: { original: DatabaseRole | null; body: RoleWrite & { name: string } }) => {
      // The two calls resolve to differently-typed axios responses; neither is read.
      await (original ? catalogApi.updateRole(original.name, body) : catalogApi.createRole(body));
    },
    invalidate: [['db-roles'], ['db-column-privileges']],
    success: ({ original, body }) => (original ? `Updated ${body.name}` : `Created ${body.name}`),
    failTitle: 'Save failed',
    onSuccess: () => setEditing(null),
  });
  const drop = useCatalogWrite({
    run: (role: DatabaseRole) => catalogApi.dropRole(role.name),
    invalidate: [['db-roles'], ['db-column-privileges']],
    success: role => `Dropped ${role.name}`,
    failTitle: 'Drop failed',
  });

  const confirmDrop = async (role: DatabaseRole) => {
    const ok = await confirmDialog({
      title: `Drop role "${role.name}"?`,
      description: role.activeConnections
        ? `It has ${role.activeConnections} open connection(s). Postgres refuses while it owns objects or holds grants.`
        : 'Postgres refuses while the role owns objects or holds grants, and says which.',
      confirmLabel: 'Drop role',
      tone: 'danger',
      typeToConfirm: role.name,
    });
    if (ok) drop.mutate(role);
  };

  return (
    <PageShell width="wide">
      <PageHeader
        title="Roles"
        subtitle="Postgres roles: logins for tools and services, and groups to grant privileges to."
        actions={
          <>
            <Checkbox checked={showPredefined} onChange={setShowPredefined} label="Show pg_* roles" />
            <WriteButton capability={CAPABILITY} className="btn btn-primary" onClick={() => setEditing('new')}>
              <Plus size={12} /> New role
            </WriteButton>
          </>
        }
      />

      <QueryState query={rolesQuery} skeletonRows={6}>
        {roles => {
          // Yours first: the platform roles are context, not the point of the page,
          // and Postgres' own fifteen pg_* roles stay folded away unless asked for.
          const visible = showPredefined ? roles : roles.filter(role => !role.name.startsWith('pg_'));
          const ordered = [...visible.filter(role => !role.reserved), ...visible.filter(role => role.reserved)];
          return (
            <div className="card overflow-x-auto p-0">
              <table className="console">
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Type</th>
                    <th>Attributes</th>
                    <th className="text-right">Connections</th>
                    <th>Member of</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {ordered.map(role => (
                    <RoleRow key={role.name} role={role} onEdit={() => setEditing(role)} onDrop={() => confirmDrop(role)} />
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </QueryState>

      {editing && (
        <RoleModal
          role={editing === 'new' ? null : editing}
          saving={save.isPending}
          onSave={body => save.mutate({ original: editing === 'new' ? null : editing, body })}
          onClose={() => setEditing(null)}
        />
      )}
    </PageShell>
  );
}
