import { useState } from 'react';
import { twoFactorApi } from '@/features/auth/api/twoFactor.api';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { useTwoFactorStatus } from '@/features/platform/hooks/useTwoFactorStatus';
import { EnrollModal } from './TwoFactorNudge';
import { SettingRow } from '@/shared/ui/Row';
import { Section } from '@/shared/ui/Section';

export function TwoFactorSettings() {
  const toast = useToast();
  const { enabled, setEnabled } = useTwoFactorStatus();
  const [modalOpen, setModalOpen] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disable(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await twoFactorApi.disable(password);
      setEnabled(false);
      setPassword('');
      setDisabling(false);
      toast.push({ kind: 'success', title: 'Two-factor disabled' });
    } catch (err) {
      setError(getErrorMessage(err, 'Unable to disable two-factor.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Two-factor authentication" titleId="account-two-factor-title" bodyClassName="space-y-3">
      <SettingRow
        label="Authenticator app"
        hint={enabled === null ? 'Checking status…' : enabled ? 'Enabled: sign-in asks for a code from the app.' : 'Not enabled.'}
      >
        {enabled === false && (
          <button className="btn btn-primary" onClick={() => setModalOpen(true)}>
            Enable 2FA
          </button>
        )}
        {enabled === true && !disabling && (
          <button className="btn" onClick={() => setDisabling(true)}>
            Disable 2FA
          </button>
        )}
      </SettingRow>

      {enabled === true && disabling && (
        <form className="max-w-sm space-y-3 border-t hairline pt-3" onSubmit={disable}>
          <input
            className="input"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Current password"
            aria-label="Current password"
            autoComplete="current-password"
            required
          />
          {error && (
            <p className="text-[12px]" style={{ color: 'var(--red)' }}>
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Disabling…' : 'Confirm disable'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setDisabling(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {modalOpen && (
        <EnrollModal
          toast={toast}
          onClose={() => setModalOpen(false)}
          onEnrolled={() => {
            setEnabled(true);
            setModalOpen(false);
          }}
        />
      )}
    </Section>
  );
}
