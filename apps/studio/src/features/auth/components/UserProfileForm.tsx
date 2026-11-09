import { useState } from 'react';
import { Field } from '@/shared/ui/Field';
import type { UpdateUserPayload } from '@/features/auth/api/users.api';
import type { AdminUser } from '@/features/auth/types';

const PROFILE_FIELDS = [
  { name: 'firstName', label: 'First name', maxLength: 80 },
  { name: 'lastName', label: 'Last name', maxLength: 80 },
  { name: 'username', label: 'Username', maxLength: 30 },
] as const;

/** Keep only edited fields so a refetch cannot erase a draft or overwrite other changes. */
export function UserProfileForm({ user, disabled, onSave }: {
  user: AdminUser;
  disabled: boolean;
  onSave: (payload: UpdateUserPayload) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<UpdateUserPayload>({});
  const dirty = PROFILE_FIELDS.some(({ name }) => draft[name] !== undefined && draft[name] !== (user[name] ?? ''));

  return (
    <form onSubmit={async event => {
      event.preventDefault();
      if (disabled || !dirty) return;
      if (await onSave(draft)) setDraft({});
    }} className="space-y-3">
      <fieldset disabled={disabled} className="space-y-3">
        {PROFILE_FIELDS.map(({ name, label, maxLength }) => (
          <Field key={name} label={label}>
            <input
              className="input w-full"
              value={draft[name] ?? user[name] ?? ''}
              onChange={event => setDraft(current => ({ ...current, [name]: event.target.value }))}
              maxLength={maxLength}
              minLength={name === 'username' ? 3 : undefined}
              pattern={name === 'username' ? '[A-Za-z0-9._\\-]+' : undefined}
              required={name === 'username'}
              autoComplete="off"
            />
          </Field>
        ))}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" disabled={!dirty} onClick={() => setDraft({})}>Discard</button>
          <button type="submit" className="btn btn-primary" disabled={!dirty}>Save profile</button>
        </div>
      </fieldset>
    </form>
  );
}
