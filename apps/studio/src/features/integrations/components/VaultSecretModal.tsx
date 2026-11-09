'use client';

import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { Field } from '@/shared/ui/Field';
import { WriteButton } from '@/shared/ui/WriteButton';
import type { VaultSecret, VaultSecretInput } from '@/features/integrations/api/vault.api';

/**
 * Add a secret, or edit one. Editing never shows the stored value: the field
 * starts empty and an empty field means "keep it", so opening the dialog is not
 * a way to read a secret.
 */
export function VaultSecretModal({
  editing,
  saving,
  onClose,
  onSave,
}: {
  editing?: VaultSecret;
  saving: boolean;
  onClose: () => void;
  onSave: (input: Partial<VaultSecretInput>) => void;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [secret, setSecret] = useState('');
  const [shown, setShown] = useState(false);
  const complete = Boolean(name.trim()) && (editing ? true : Boolean(secret));

  const submit = () => {
    if (!editing) return onSave({ name: name.trim(), secret, description });
    // Only what changed: an untouched value stays sealed as it is.
    onSave({
      ...(name.trim() !== editing.name ? { name: name.trim() } : {}),
      ...(description !== editing.description ? { description } : {}),
      ...(secret ? { secret } : {}),
    });
  };

  return (
    <Modal onClose={onClose} width="520px">
      <ModalHeader
        title={editing ? 'Edit secret' : 'Add new secret'}
        description="Encrypted with the server-held vault key before it is stored. The database never sees the key."
      />
      <ModalBody className="space-y-4">
        <Field label="Name" required>
          <input value={name} onChange={e => setName(e.target.value)} className="input mono" placeholder="stripe_api_key" autoFocus />
        </Field>
        <Field label="Description">
          <input value={description} onChange={e => setDescription(e.target.value)} className="input" placeholder="Optional" />
        </Field>
        <Field label={editing ? 'New secret value' : 'Secret value'} required={!editing} hint={editing ? 'Leave empty to keep the current value.' : undefined}>
          <div className="flex gap-2">
            <input
              type={shown ? 'text' : 'password'}
              value={secret}
              onChange={e => setSecret(e.target.value)}
              className="input mono flex-1"
              autoComplete="off"
            />
            <button type="button" className="btn btn-ghost" onClick={() => setShown(!shown)} title={shown ? 'Hide' : 'Show'}>
              {shown ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
        </Field>
      </ModalBody>
      <ModalFooter>
        <button onClick={onClose} className="btn">
          Cancel
        </button>
        <WriteButton capability="secrets.manage" onClick={submit} className="btn btn-primary" disabled={!complete || saving}>
          {saving ? 'Saving…' : editing ? 'Save' : 'Add secret'}
        </WriteButton>
      </ModalFooter>
    </Modal>
  );
}
