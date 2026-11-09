import { getErrorMessage } from '@/shared/lib/errors';
import { useEffect, useState } from 'react';
import { ShieldCheck, X, Copy, Check } from 'lucide-react';
import { twoFactorApi, secretFromTotpURI, type EnableResult } from '@/features/auth/api/twoFactor.api';
import { useTwoFactorStatus } from '@/features/platform/hooks/useTwoFactorStatus';
import { useToast } from '@/shared/lib/toast';
import { Field } from '@/shared/ui/Field';
import { safeSessionStorage } from '@/shared/lib/safe-storage';

const DISMISS_KEY = 'console.mfaNudgeDismissed';

// Passive, dismissible recommendation to enroll console 2FA, plus the enrollment
// modal. Renders nothing while the status is loading, when the operator already
// has 2FA on, or once dismissed. Enrollment is the two-step Better Auth flow:
// enable (secret + backup codes) → verify a TOTP code to activate.
export default function TwoFactorNudge() {
  const toast = useToast();
  const { enabled, setEnabled } = useTwoFactorStatus();
  const [dismissed, setDismissed] = useState(() => safeSessionStorage.get(DISMISS_KEY) === '1');
  const [modalOpen, setModalOpen] = useState(false);

  function dismiss() {
    safeSessionStorage.set(DISMISS_KEY, '1');
    setDismissed(true);
  }

  if (enabled !== false || dismissed) return null;

  return (
    <>
      <div
        className="flex flex-wrap items-center gap-3 border-b hairline px-3 py-2.5 text-[13px] sm:px-5"
        style={{ background: 'color-mix(in srgb, var(--accent) 10%, transparent)' }}
      >
        <ShieldCheck size={15} style={{ color: 'var(--accent)' }} />
        <span className="min-w-0 flex-1" style={{ color: 'var(--text)' }}>
          Recommended: protect your console account with two-factor authentication.
        </span>
        <div className="flex w-full items-center justify-end gap-2 sm:ml-auto sm:w-auto">
          <button onClick={() => setModalOpen(true)} className="btn btn-primary">
            Enable 2FA
          </button>
          <button onClick={dismiss} className="btn btn-ghost" title="Dismiss" aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      </div>

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
    </>
  );
}

export function EnrollModal({
  toast,
  onClose,
  onEnrolled,
}: {
  toast: ReturnType<typeof useToast>;
  onClose: () => void;
  onEnrolled: () => void;
}) {
  const [step, setStep] = useState<'password' | 'setup'>('password');
  const [password, setPassword] = useState('');
  const [enrollment, setEnrollment] = useState<EnableResult | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  // Render the provisioning URI as a scannable QR the moment enrollment starts.
  useEffect(() => {
    if (!enrollment) return;
    let cancelled = false;
    // `qrcode` is fetched here rather than imported at the top: this component
    // is mounted on every console page to show a dismissible nudge, but the
    // encoder is only ever needed by the operator who actually starts enrolling.
    import('qrcode')
      .then(({ default: QRCode }) => QRCode.toDataURL(enrollment.totpURI, { margin: 1, width: 190 }))
      .then(dataUrl => {
        if (!cancelled) setQr(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enrollment]);

  async function startEnable(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await twoFactorApi.enable(password);
      setEnrollment(res);
      setStep('setup');
    } catch (err) {
      setError(getErrorMessage(err, 'Incorrect password.'));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await twoFactorApi.verifyTotp(code.trim());
      toast.push({ kind: 'success', title: 'Two-factor enabled' });
      onEnrolled();
    } catch (err) {
      setError(getErrorMessage(err, 'Invalid code: try the next one.'));
    } finally {
      setBusy(false);
    }
  }

  const secret = enrollment ? secretFromTotpURI(enrollment.totpURI) : null;

  function copyBackup() {
    if (!enrollment) return;
    navigator.clipboard.writeText(enrollment.backupCodes.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="two-factor-enrollment-title"
        className="card max-h-dvh w-full max-w-md overflow-y-auto rounded-b-none p-4 sm:rounded-b-[var(--radius)] sm:p-6"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-2">
          <h2 id="two-factor-enrollment-title" className="text-[16px]" style={{ fontWeight: 600 }}>
            Enable two-factor
          </h2>
          <button onClick={onClose} className="btn btn-ghost ml-auto" aria-label="Close">
            <X size={15} />
          </button>
        </div>

        {step === 'password' ? (
          <form onSubmit={startEnable} className="space-y-4">
            <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
              Confirm your password to generate a new authenticator secret.
            </p>
            <input
              className="input"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Current password"
              required
              autoFocus
            />
            {error && (
              <p className="text-[12px]" style={{ color: 'var(--red)' }}>
                {error}
              </p>
            )}
            <button type="submit" disabled={busy} className="btn btn-primary w-full justify-center">
              {busy ? 'Working…' : 'Continue'}
            </button>
          </form>
        ) : (
          <form onSubmit={confirm} className="space-y-4">
            <div>
              <div className="label mb-2">1 · Scan with your authenticator app</div>
              <div className="flex flex-col items-center gap-3">
                {qr ? (
                  <img
                    src={qr}
                    alt="Two-factor QR code"
                    width={190}
                    height={190}
                    className="rounded-md border hairline"
                    style={{ background: '#fff', padding: 6 }}
                  />
                ) : (
                  <div
                    className="rounded-md border hairline"
                    style={{ width: 190, height: 190, display: 'grid', placeItems: 'center' }}
                  >
                    <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
                      Generating…
                    </span>
                  </div>
                )}
                <p className="text-center text-[11px]" style={{ color: 'var(--text-mute)' }}>
                  Google Authenticator, 1Password, Authy… (issuer: Motherbase Console)
                </p>
                <button
                  type="button"
                  onClick={() => setShowKey(k => !k)}
                  className="text-[11px] hover:underline"
                  style={{ color: 'var(--text-mute)' }}
                >
                  {showKey ? 'Hide key' : "Can't scan? Enter the key manually"}
                </button>
                {showKey && (
                  <div
                    className="mono w-full break-all rounded-md border hairline px-3 py-2 text-center text-[12px]"
                    style={{ background: 'var(--surface-2, var(--surface))' }}
                  >
                    {secret ?? enrollment?.totpURI}
                  </div>
                )}
              </div>
            </div>

            <div>
              <div className="label mb-1 flex items-center gap-2">
                2 · Save your backup codes
                <button type="button" onClick={copyBackup} className="btn btn-ghost ml-auto text-[11px]">
                  {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div
                className="mono grid grid-cols-2 gap-1 rounded-md border hairline p-3 text-[12px]"
                style={{ background: 'var(--surface-2, var(--surface))' }}
              >
                {enrollment?.backupCodes.map(c => (
                  <span key={c}>{c}</span>
                ))}
              </div>
              <p className="mt-1 text-[11px]" style={{ color: 'var(--amber)' }}>
                Store these somewhere safe: each works once if you lose your device.
              </p>
            </div>

            <Field label="3 · Enter a code to confirm">
              <input
                className="input tracking-[0.4em]"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                placeholder="123456"
                required
                autoFocus
              />
            </Field>

            {error && (
              <p className="text-[12px]" style={{ color: 'var(--red)' }}>
                {error}
              </p>
            )}
            <button type="submit" disabled={busy} className="btn btn-primary w-full justify-center">
              {busy ? 'Verifying…' : 'Turn on 2FA'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
