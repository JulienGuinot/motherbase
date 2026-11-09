import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, UserPlus } from 'lucide-react';
import { orgsApi, type Org, type OrgRole } from '@/features/platform/api/orgs.api';
import { hasPlatformCapability, usePlatformMe } from '@/features/platform/hooks/usePlatformAccess';
import { platform } from '@/shared/lib/api';
import { getErrorMessage } from '@/shared/lib/errors';
import { useOrgs } from '@/shared/lib/org';
import { useToast } from '@/shared/lib/toast';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { CreateOrgModal } from '@/shared/ui/OrgSwitcher';
import { SettingRow } from '@/shared/ui/Row';
import { Section } from '@/shared/ui/Section';
import Select from '@/shared/ui/Select';

const ROLE_OPTIONS = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
  { value: 'owner', label: 'Owner' },
];

const ROLE_LABEL: Record<OrgRole, string> = { member: 'Member', admin: 'Admin', owner: 'Owner' };

/** Run an org change, report it, and refresh the org list the shell reads. */
function useOrgAction() {
  const toast = useToast();
  const { reload } = useOrgs();
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<unknown>, done: string, failed: string): Promise<boolean> {
    setBusy(true);
    try {
      await action();
      await reload();
      toast.push({ kind: 'success', title: done });
      return true;
    } catch (e) {
      toast.push({ kind: 'error', title: failed, message: getErrorMessage(e) });
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
}

function ReadOnlyNote() {
  return (
    <p className="text-[11px]" role="status" style={{ color: 'var(--text-mute)' }}>
      Read-only: changing the organization takes its Owner or Admin role.
    </p>
  );
}

/** Org settings › General: the active organization's name, and deleting it. */
export function OrgGeneralPanel() {
  const { active } = useOrgs();
  if (!active) return <p className="text-[13px]" style={{ color: 'var(--text-mute)' }}>No organization selected.</p>;
  // Re-keyed per org so the name draft never leaks from one org to the next.
  return <OrgGeneral key={active.id} org={active} />;
}

function OrgGeneral({ org }: { org: Org }) {
  const [name, setName] = useState(org.name);
  const { busy, run } = useOrgAction();
  const canManage = org.role === 'owner' || org.role === 'admin';
  const changed = name.trim() !== '' && name.trim() !== org.name;

  async function deleteOrg() {
    const confirmed = await confirmDialog({
      title: `Delete organization "${org.name}"?`,
      description: 'Its members lose access to it immediately.',
      confirmLabel: 'Delete organization',
      tone: 'danger',
      typeToConfirm: org.name,
    });
    if (confirmed) await run(() => orgsApi.remove(org.id), 'Organization deleted', 'Delete failed');
  }

  return (
    <div className="space-y-6">
      <Section
        title="Organization"
        bodyClassName="space-y-3"
        footer={canManage ? (
          <button className="btn btn-primary" disabled={!changed || busy} onClick={() => run(() => orgsApi.rename(org.id, name.trim()), 'Organization renamed', 'Rename failed')}>
            Save
          </button>
        ) : undefined}
      >
        <SettingRow label="Name" hint="Shown in the switcher and on every project of the organization.">
          <div className="w-full sm:w-72">
            <input
              className="input"
              value={name}
              disabled={!canManage || busy}
              onChange={e => setName(e.target.value)}
              aria-label="Organization name"
            />
          </div>
        </SettingRow>
        <SettingRow label="Slug" hint="Fixed when the organization is created.">
          <span className="mono text-[12px]" style={{ color: 'var(--text-dim)' }}>{org.slug}</span>
        </SettingRow>
        <SettingRow label="Projects">
          <span className="text-[13px] tabular-nums">{org.projectCount}</span>
        </SettingRow>
        {!canManage && <ReadOnlyNote />}
      </Section>

      {org.role === 'owner' && (
        <Section title="Danger zone" tone="danger" bodyClassName="space-y-3">
          <SettingRow
            label="Delete organization"
            hint={org.projectCount > 0
              ? `It still owns ${org.projectCount} project${org.projectCount === 1 ? '' : 's'}: delete or move them first.`
              : 'Permanent. Its members lose access immediately.'}
          >
            <button className="btn" style={{ color: 'var(--red)' }} disabled={busy || org.projectCount > 0} onClick={deleteOrg}>
              <Trash2 size={12} /> Delete organization
            </button>
          </SettingRow>
        </Section>
      )}
    </div>
  );
}

/** Org settings › Members: who belongs to the active organization, and as what. */
export function OrgMembersPanel() {
  const { active } = useOrgs();
  const meQuery = usePlatformMe();
  const queryClient = useQueryClient();
  const { busy, run } = useOrgAction();
  const [addUser, setAddUser] = useState('');
  const [addRole, setAddRole] = useState<OrgRole>('member');
  const orgId = active?.id;
  const canManage = active?.role === 'owner' || active?.role === 'admin';
  const canListUsers = hasPlatformCapability(meQuery.data, 'users.manage');

  const membersQ = useQuery({
    queryKey: ['org-members', orgId],
    queryFn: () => orgsApi.members(orgId!),
    enabled: Boolean(orgId),
  });
  const usersQ = useQuery({
    queryKey: ['platform-users'],
    queryFn: platform.users.list,
    enabled: canManage && canListUsers,
  });

  if (!active || !orgId) return <p className="text-[13px]" style={{ color: 'var(--text-mute)' }}>No organization selected.</p>;

  const members = membersQ.data ?? [];
  const memberIds = new Set(members.map(m => m.userId));
  const addable = (usersQ.data ?? []).filter(u => !memberIds.has(u.id));

  async function change(action: () => Promise<unknown>, done: string, failed: string) {
    if (await run(action, done, failed)) await queryClient.invalidateQueries({ queryKey: ['org-members', orgId] });
  }

  async function remove(userId: string, email: string) {
    const confirmed = await confirmDialog({
      title: `Remove ${email} from ${active!.name}?`,
      description: 'They lose access to its projects unless they are assigned to them some other way.',
      confirmLabel: 'Remove member',
      tone: 'danger',
    });
    if (confirmed) await change(() => orgsApi.removeMember(orgId!, userId), 'Member removed', 'Remove failed');
  }

  return (
    <Section
      title="Members"
      description={`Console users who belong to ${active.name}. Owners and admins manage it; owners can also delete it.`}
      flush
      footer={canManage && canListUsers ? (
        <div className="flex w-full flex-wrap items-center gap-2">
          <Select
            value={addUser}
            onChange={setAddUser}
            options={addable.map(u => ({ value: u.id, label: u.email }))}
            placeholder={addable.length ? 'Add a console user…' : 'Every console user is a member'}
            disabled={addable.length === 0}
            ariaLabel="User to add"
            className="min-w-[240px] flex-1"
          />
          <Select value={addRole} onChange={v => setAddRole(v as OrgRole)} options={ROLE_OPTIONS} ariaLabel="Role" />
          <button
            className="btn btn-primary"
            disabled={busy || !addUser}
            onClick={async () => {
              await change(() => orgsApi.addMember(orgId, addUser, addRole), 'Member added', 'Add failed');
              setAddUser('');
            }}
          >
            <UserPlus size={13} /> Add
          </button>
        </div>
      ) : undefined}
    >
      {membersQ.isPending ? (
        <div className="space-y-2 p-5">{[1, 2, 3].map(i => <div key={i} className="shimmer h-8 rounded-md" />)}</div>
      ) : members.length === 0 ? (
        <p className="px-5 py-4 text-[12px]" style={{ color: 'var(--text-mute)' }}>No members.</p>
      ) : (
        <ul>
          {members.map(m => {
            const email = m.email ?? m.userId;
            return (
              <li key={m.userId} className="flex items-center gap-3 border-t hairline px-5 py-3 first:border-t-0">
                <span className="min-w-0 flex-1 truncate text-[13px]">{email}</span>
                {canManage ? (
                  <Select
                    value={m.role}
                    onChange={role => change(() => orgsApi.addMember(orgId, m.userId, role as OrgRole), 'Role updated', 'Role change failed')}
                    options={ROLE_OPTIONS}
                    disabled={busy}
                    ariaLabel={`Role of ${email}`}
                  />
                ) : (
                  <span className="chip">{ROLE_LABEL[m.role]}</span>
                )}
                {canManage && (
                  <button
                    className="btn btn-ghost"
                    style={{ color: 'var(--red)' }}
                    disabled={busy}
                    onClick={() => remove(m.userId, email)}
                    aria-label={`Remove ${email}`}
                    title="Remove member"
                  >
                    <Trash2 size={13} />
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

/**
 * Org settings › Organizations: every organization on this console, for its
 * owners and admins. The switcher only ever shows the active one's settings,
 * so this is where an org that is not active gets opened or deleted.
 */
export function OrganizationsPanel() {
  const { orgs, active, setActiveOrg, reload } = useOrgs();
  const { busy, run } = useOrgAction();
  const [creating, setCreating] = useState(false);

  async function remove(org: Org) {
    const confirmed = await confirmDialog({
      title: `Delete organization "${org.name}"?`,
      description: 'Its members lose access to it immediately.',
      confirmLabel: 'Delete organization',
      tone: 'danger',
      typeToConfirm: org.name,
    });
    if (confirmed) await run(() => orgsApi.remove(org.id), 'Organization deleted', 'Delete failed');
  }

  return (
    <>
      <Section
        title="Organizations"
        description="Every organization on this console. Delete one once it owns no projects."
        actions={
          <button className="btn" onClick={() => setCreating(true)}>
            <Plus size={13} /> New organization
          </button>
        }
        flush
      >
        <ul>
          {orgs.map(org => (
            <li key={org.id} className="flex flex-wrap items-center gap-3 border-t hairline px-5 py-3 first:border-t-0">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13px]">
                  <span className="truncate">{org.name}</span>
                  {org.id === active?.id && <span className="chip">Current</span>}
                </div>
                <div className="mt-0.5 text-[11px] tabular-nums" style={{ color: 'var(--text-mute)' }}>
                  <span className="mono">{org.slug}</span> · {org.projectCount} project{org.projectCount === 1 ? '' : 's'}
                </div>
              </div>
              {org.id !== active?.id && (
                <button className="btn btn-ghost" onClick={() => setActiveOrg(org.id)}>Open</button>
              )}
              {org.role === 'owner' && (
                <button
                  className="btn btn-ghost"
                  style={{ color: 'var(--red)' }}
                  disabled={busy || org.projectCount > 0}
                  title={org.projectCount > 0 ? 'Delete or move its projects first' : 'Delete organization'}
                  aria-label={`Delete ${org.name}`}
                  onClick={() => remove(org)}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </Section>

      {creating && (
        <CreateOrgModal
          onClose={() => setCreating(false)}
          onCreated={async id => {
            setCreating(false);
            await reload();
            setActiveOrg(id);
          }}
        />
      )}
    </>
  );
}
