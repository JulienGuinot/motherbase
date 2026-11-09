import { useState } from 'react';
import { Copy } from 'lucide-react';
import Select from '@/shared/ui/Select';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { Field, Checkbox } from '@/shared/ui/Field';
import type { CreateUserPayload } from '@/features/auth/api/users.api';

export function CreateUserModal({
  createdPassword,
  saving,
  onClose,
  onCreate,
}: {
  createdPassword: string | null;
  saving: boolean;
  onClose: () => void;
  onCreate: (payload: CreateUserPayload) => void;
}) {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<'USER' | 'ADMIN'>('USER');
  const [password, setPassword] = useState('');
  const [sendInvite, setSendInvite] = useState(false);
  const [emailVerified, setEmailVerified] = useState(true);

  return (
    <Modal onClose={onClose} width="560px">
      <ModalHeader
        title="Create identity"
      />

      <ModalBody className="space-y-4">
        <Field label="Email">
          <input
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="input mono w-full"
            placeholder="person@example.com"
            autoFocus
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username">
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              className="input w-full"
              placeholder="auto from email"
            />
          </Field>
          <Field label="Role">
            <Select
              value={role}
              onChange={v => setRole(v as 'USER' | 'ADMIN')}
              ariaLabel="Role"
              style={{ width: '100%' }}
              options={[
                { value: 'USER', label: 'User' },
                { value: 'ADMIN', label: 'Admin' },
              ]}
            />
          </Field>
        </div>

        <Field label="Temporary password">
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="input mono w-full"
            placeholder="leave blank to auto-generate"
          />
        </Field>

        <Checkbox checked={emailVerified} onChange={setEmailVerified} label="Mark email as verified" />

        <Checkbox
          checked={sendInvite}
          onChange={setSendInvite}
          label="Send invitation email with the temporary password"
        />

        {createdPassword && (
          <div
            className="border p-3"
            style={{ background: 'var(--surface-2)', borderColor: 'var(--border-strong)', borderRadius: 'var(--radius-sm)' }}
          >
            <div className="label mb-1.5" style={{ color: 'var(--accent)' }}>
              Temporary password: copy before closing
            </div>
            <div className="flex items-center gap-2">
              <code className="mono flex-1 break-all text-[12px]">{createdPassword}</code>
              <button
                onClick={() => navigator.clipboard.writeText(createdPassword)}
                className="btn btn-ghost shrink-0"
              >
                <Copy size={12} /> Copy
              </button>
            </div>
          </div>
        )}
      </ModalBody>

      <ModalFooter>
        <button onClick={onClose} className="btn">Close</button>
        <button
          onClick={() => onCreate({ email, username: username || undefined, role, password: password || undefined, sendInvite, emailVerified })}
          className="btn btn-primary"
          disabled={!email || saving}
        >
          {saving ? 'Creating…' : 'Create user'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
