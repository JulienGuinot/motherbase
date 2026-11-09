import { getErrorMessage } from '@/shared/lib/errors';
import { useState } from 'react';
import { Building2, Plus } from 'lucide-react';
import Select from '@/shared/ui/Select';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { useOrgs } from '@/shared/lib/org';
import { orgsApi } from '@/features/platform/api/orgs.api';
import { useToast } from '@/shared/lib/toast';

// Active-org picker (Supabase-style). Switches the active tenant org and offers
// inline creation. Reused in the org shell header and the project topbar breadcrumb.
export default function OrgSwitcher({ compact = false }: { compact?: boolean }) {
  const { orgs, activeOrgId, setActiveOrg, reload } = useOrgs();
  const [creating, setCreating] = useState(false);

  const options = orgs.map(o => ({ value: o.id, label: o.name }));

  return (
    <div className="flex min-w-0 items-center">
      <Select
        value={activeOrgId ?? ''}
        onChange={id => setActiveOrg(id)}
        options={options}
        placeholder={orgs.length ? 'Select organization…' : 'No organizations'}
        leadingIcon={<Building2 size={13} />}
        ariaLabel="Organization"
        className={compact ? undefined : 'min-w-0 flex-1'}
        footer={close => (
          <button
            type="button"
            onClick={() => { close(); setCreating(true); }}
            className="nav-item flex w-full items-center gap-2 px-2 py-1.5 text-[13px]"
            style={{ borderRadius: 'var(--radius-sm)', color: 'var(--accent)' }}
          >
            <Plus size={14} /> New organization
          </button>
        )}
      />

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
    </div>
  );
}

export function CreateOrgModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const org = await orgsApi.create(name.trim());
      toast.push({ kind: 'success', title: 'Organization created' });
      onCreated(org.id);
    } catch (err) {
      toast.push({ kind: 'error', title: 'Create failed', message: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} width="440px">
      <form onSubmit={submit} className="flex flex-col">
        <ModalHeader title="New organization" description="Create a workspace to group projects and members." />
        <ModalBody>
          <label className="label">Name</label>
          <input className="input mt-1 w-full" value={name} onChange={e => setName(e.target.value)} placeholder="Acme Inc" autoFocus required />
        </ModalBody>
        <ModalFooter>
          <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
          <button type="submit" disabled={busy || !name.trim()} className="btn btn-primary">
            {busy ? 'Creating…' : 'Create organization'}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
