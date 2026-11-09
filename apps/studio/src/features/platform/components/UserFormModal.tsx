import { useState } from 'react';
import Select from '@/shared/ui/Select';
import { isProjectScopedRole, type PlatformRole, type PlatformUser } from '@/shared/lib/api';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { Field, Checkbox } from '@/shared/ui/Field';

export function UserFormModal({
  user,
  projects,
  saving,
  onClose,
  onSubmit,
}: {
  user?: PlatformUser;
  projects: string[];
  saving: boolean;
  onClose: () => void;
  onSubmit: (payload: {
    email: string;
    password?: string;
    role: PlatformRole;
    projects: string[];
    disabled: boolean;
  }) => void;
}) {
  const isEdit = Boolean(user);
  const [email, setEmail] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<PlatformRole>(user?.role ?? 'developer');
  const [assigned, setAssigned] = useState<string[]>(user?.projects ?? []);
  const [disabled, setDisabled] = useState(user?.disabled ?? false);

  const toggleProject = (name: string) =>
    setAssigned(list => (list.includes(name) ? list.filter(p => p !== name) : [...list, name]));

  const emailValid = /.+@.+\..+/.test(email);
  const pwValid = isEdit ? password === '' || password.length >= 8 : password.length >= 8;
  const canSubmit = emailValid && pwValid && !saving;

  return (
    <Modal onClose={onClose} width="560px">
      <ModalHeader title={isEdit ? 'Edit console user' : 'Add console user'} />
      <ModalBody className="space-y-4">
        <Field label="Email">
          <input
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="input mono"
            placeholder="operator@example.com"
            disabled={isEdit}
            autoFocus={!isEdit}
          />
        </Field>

        <Field label={<>{isEdit ? 'Reset password' : 'Password'}</>}>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="input mono"
            placeholder={isEdit ? 'leave blank to keep current' : 'at least 8 characters'}
            autoComplete="new-password"
          />
          {password.length > 0 && password.length < 8 && (
            <p className="mt-1 text-[11px]" style={{ color: 'var(--danger)' }}>
              Must be at least 8 characters
            </p>
          )}
        </Field>

        <Field label="Role">
          <Select
            value={role}
            onChange={v => setRole(v as PlatformRole)}
            ariaLabel="Role"
            style={{ width: '100%' }}
            options={[
              { value: 'owner', label: 'Owner (full control' },
              { value: 'admin', label: 'Admin) manage all projects' },
              { value: 'developer', label: 'Developer (assigned projects' },
              { value: 'read_only', label: 'Read-only) view assigned projects' },
              ...(user?.role === 'member'
                ? [{ value: 'member', label: 'Developer (legacy member)', disabled: true }]
                : []),
            ]}
          />
        </Field>

        {isProjectScopedRole(role) && (
          <div>
            <span className="label mb-1.5 block">Assigned projects</span>
            {projects.length === 0 ? (
              <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
                No projects to assign.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {projects.map(name => {
                  const on = assigned.includes(name);
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => toggleProject(name)}
                      className="chip"
                      style={{
                        cursor: 'pointer',
                        color: on ? 'var(--accent-fg)' : 'var(--text-dim)',
                        background: on ? 'var(--accent)' : undefined,
                        borderColor: on ? 'var(--accent)' : undefined,
                      }}
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {isEdit && (
          <Checkbox checked={disabled} onChange={setDisabled} label="Disable this user (blocks sign-in)" />
        )}
      </ModalBody>
      <ModalFooter>
        <button onClick={onClose} className="btn">
          Cancel
        </button>
        <button
          onClick={() => onSubmit({ email, password, role, projects: assigned, disabled })}
          className="btn btn-primary"
          disabled={!canSubmit}
        >
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create user'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
