import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { platform } from '@/shared/lib/api';
import { getErrorMessage } from '@/shared/lib/errors';

const MIN_PASSWORD_LENGTH = 8;

interface PasswordChangeFormProps {
  autoFocusCurrent?: boolean;
  onChanged?: () => void | Promise<void>;
  submitLabel?: string;
}

export function PasswordChangeForm({
  autoFocusCurrent = false,
  onChanged,
  submitLabel = 'Update password',
}: PasswordChangeFormProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');

  const tooShort = newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirmation.length > 0 && confirmation !== newPassword;
  const valid = currentPassword.length > 0
    && newPassword.length >= MIN_PASSWORD_LENGTH
    && confirmation === newPassword;

  const change = useMutation({
    mutationFn: () => platform.changePassword(currentPassword, newPassword),
    onSuccess: async () => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      await onChanged?.();
    },
  });

  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        if (valid) change.mutate();
      }}
      className="space-y-5"
    >
      <label className="block">
        <span className="mb-1.5 block text-[12px] font-medium" style={{ color: 'var(--text-dim)' }}>
          Current password
        </span>
        <input
          type="password"
          value={currentPassword}
          onChange={event => setCurrentPassword(event.target.value)}
          className="input"
          autoComplete="current-password"
          required
          autoFocus={autoFocusCurrent}
        />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-[12px] font-medium" style={{ color: 'var(--text-dim)' }}>
          New password
        </span>
        <input
          type="password"
          value={newPassword}
          onChange={event => setNewPassword(event.target.value)}
          className="input"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
        {tooShort && (
          <p className="mt-1 text-[11px]" style={{ color: 'var(--danger)' }}>
            Must be at least {MIN_PASSWORD_LENGTH} characters
          </p>
        )}
      </label>
      <label className="block">
        <span className="mb-1.5 block text-[12px] font-medium" style={{ color: 'var(--text-dim)' }}>
          Confirm new password
        </span>
        <input
          type="password"
          value={confirmation}
          onChange={event => setConfirmation(event.target.value)}
          className="input"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
        {mismatch && (
          <p className="mt-1 text-[11px]" style={{ color: 'var(--danger)' }}>
            Passwords do not match
          </p>
        )}
      </label>
      {change.isError && (
        <p role="alert" className="text-[12px]" style={{ color: 'var(--danger)' }}>
          {getErrorMessage(change.error, 'Unable to change the password.')}
        </p>
      )}
      <div className="flex justify-end">
        <button type="submit" disabled={!valid || change.isPending} className="btn btn-primary">
          <Lock size={12} aria-hidden="true" />
          {change.isPending ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
