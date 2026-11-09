import { useState, type ReactNode } from 'react';
import { KeyRound } from 'lucide-react';
import type { AdminUser, UserDetail } from '@/features/auth/types';
import { DetailField } from '@/shared/ui/DetailField';

const MIN_PASSWORD = 8;

function Hint({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`text-[11px] ${className}`} style={{ color: 'var(--text-mute)' }}>{children}</p>;
}

function PasswordReset({ disabled, onReset }: { disabled: boolean; onReset: (pwd: string) => Promise<boolean> }) {
  const [pwd, setPwd] = useState('');
  return (
    <div>
      <div className="label mb-2">Reset password</div>
      <div className="flex gap-2">
        <input
          type="password"
          value={pwd}
          onChange={e => setPwd(e.target.value)}
          placeholder="New password"
          aria-label="New password"
          autoComplete="new-password"
          disabled={disabled}
          className="input"
        />
        <button
          disabled={disabled || pwd.length < MIN_PASSWORD}
          onClick={async () => { if (await onReset(pwd)) setPwd(''); }}
          className="btn btn-primary shrink-0"
        >
          <KeyRound size={12} /> Reset
        </button>
      </div>
      <Hint className="mt-2">At least {MIN_PASSWORD} characters. Resets all active sessions.</Hint>
    </div>
  );
}

export function SecurityTab({
  user,
  loaded,
  canManageCredentials,
  canEditProfile,
  onVerification,
  onToggleActive,
  onResetPassword,
}: {
  user: UserDetail;
  /** The full detail arrived: status toggles must not act on the list row's partial copy. */
  loaded: boolean;
  canManageCredentials: boolean;
  canEditProfile: boolean;
  onVerification: (verified: boolean) => void;
  onToggleActive: (user: AdminUser) => void;
  onResetPassword: (pwd: string) => Promise<boolean>;
}) {
  return (
    <div className="space-y-8">
      <div>
        <div className="space-y-2 flex items-center justify-between">
          <DetailField label="Email verified" value={user.emailVerified ? 'Yes' : 'No'} />
          <button className="btn" disabled={!canManageCredentials || !loaded} onClick={() => onVerification(!user.emailVerified)}>
            {user.emailVerified ? 'Mark email as unverified' : 'Mark email as verified'}
          </button>
        </div>
       <Hint>Updates verification directly without sending an email.</Hint>
      </div>
      <div>
        <div className="space-y-2 flex items-center justify-between">
          <DetailField label="Account status" value={user.status} />
          <button className="btn" disabled={!canEditProfile || !loaded} onClick={() => onToggleActive(user)}>
            {user.status === 'active' ? 'Deactivate account' : 'Reactivate account'}
          </button>
        </div>
        <Hint>Deactivation ends all sessions and blocks access.</Hint>
      </div>
      <PasswordReset disabled={!canManageCredentials} onReset={onResetPassword} />
    </div>
  );
}
