'use client';

import { useState } from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { Field } from '@/shared/ui/Field';
import { ToggleRow } from '@/shared/ui/Toggle';
import type { DatabaseRole, RoleAttributes, RoleWrite } from '@/features/database/api/catalog.api';

const ATTRIBUTES: Array<{ key: keyof Omit<RoleAttributes, 'connectionLimit'>; label: string; hint: string }> = [
  { key: 'canLogin', label: 'Can log in', hint: 'Without it the role is a group others inherit privileges from.' },
  { key: 'inheritRole', label: 'Inherit privileges', hint: 'Use the privileges of the roles this role is a member of.' },
  { key: 'canCreateDb', label: 'Create databases', hint: 'CREATEDB.' },
  { key: 'canCreateRole', label: 'Create roles', hint: 'CREATEROLE: can create, alter and drop other roles.' },
  { key: 'canBypassRls', label: 'Bypass row level security', hint: 'Every policy is ignored for this role.' },
  { key: 'canReplicate', label: 'Replication', hint: 'May open replication connections and read the WAL.' },
  { key: 'isSuperuser', label: 'Superuser', hint: 'Bypasses every permission check. Almost never what you want.' },
];

const NEW_ROLE: RoleAttributes = {
  canLogin: true,
  isSuperuser: false,
  canCreateDb: false,
  canCreateRole: false,
  canReplicate: false,
  canBypassRls: false,
  inheritRole: true,
  connectionLimit: -1,
};

/** The fields that changed, so an edit sends an ALTER of exactly those. */
export function roleChanges(before: RoleAttributes, after: RoleAttributes): Partial<RoleAttributes> {
  return Object.fromEntries(
    (Object.keys(after) as Array<keyof RoleAttributes>)
      .filter(key => before[key] !== after[key])
      .map(key => [key, after[key]]),
  ) as Partial<RoleAttributes>;
}

/** Create a role, or edit one (`role` given). Passwords are write-only: blank keeps the current one. */
export function RoleModal({ role, saving, onSave, onClose }: {
  role: DatabaseRole | null;
  saving: boolean;
  onSave: (body: RoleWrite & { name: string }) => void;
  onClose: () => void;
}) {
  const initial = role ?? NEW_ROLE;
  const [name, setName] = useState(role?.name ?? '');
  const [password, setPassword] = useState('');
  const [attributes, setAttributes] = useState<RoleAttributes>(() => ({
    canLogin: initial.canLogin,
    isSuperuser: initial.isSuperuser,
    canCreateDb: initial.canCreateDb,
    canCreateRole: initial.canCreateRole,
    canReplicate: initial.canReplicate,
    canBypassRls: initial.canBypassRls,
    inheritRole: initial.inheritRole,
    connectionLimit: initial.connectionLimit,
  }));

  const submit = () => {
    const changed = role ? roleChanges(role, attributes) : attributes;
    onSave({ ...changed, name: name.trim(), ...(password ? { password } : {}) });
  };

  return (
    <Modal onClose={onClose}>
      <ModalHeader
        title={role ? `Edit role ${role.name}` : 'New role'}
        description={role ? undefined : 'A Postgres role: a login for a tool or service, or a group to grant privileges to.'}
      />
      <ModalBody className="space-y-4">
        <Field label="Name" hint={role ? 'Renaming a role clears an MD5 password; SCRAM passwords survive.' : undefined}>
          <input className="input mono w-full" value={name} placeholder="reporting_reader" onChange={event => setName(event.target.value)} autoFocus={!role} />
        </Field>
        <Field label="Password" hint={role ? 'Leave blank to keep the current one.' : 'Needed to log in with a password.'}>
          <input className="input mono w-full" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} />
        </Field>
        <Field label="Connection limit" hint="-1 for unlimited.">
          <input
            className="input w-32 tabular-nums"
            type="number"
            min={-1}
            value={attributes.connectionLimit}
            onChange={event => setAttributes(current => ({ ...current, connectionLimit: Number(event.target.value) }))}
          />
        </Field>
        <div>
          {ATTRIBUTES.map(attribute => (
            <ToggleRow
              key={attribute.key}
              label={attribute.label}
              hint={attribute.hint}
              checked={attributes[attribute.key]}
              onChange={value => setAttributes(current => ({ ...current, [attribute.key]: value }))}
            />
          ))}
        </div>
      </ModalBody>
      <ModalFooter>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={saving || !name.trim()} onClick={submit}>
          {role ? 'Save role' : 'Create role'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
