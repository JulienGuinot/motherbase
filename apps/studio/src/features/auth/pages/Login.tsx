'use client';

import { ArrowRight } from 'lucide-react';
import { Mascot } from '@/shared/ui/Mascot';
import { useLogin } from '@/features/auth/hooks/useLogin';
import { CredentialFields, LoginNotice, SecondFactorField } from '@/features/auth/components/LoginFields';

export default function Login() {
  const login = useLogin();
  const { needsSecondFactor: secondFactor } = login;

  const submitLabel = login.loading
    ? secondFactor
      ? 'Verifying…'
      : 'Signing in…'
    : secondFactor
      ? 'Verify code'
      : 'Enter console';

  return (
    <div className="relative grid min-h-screen lg:grid-cols-[55fr_45fr]" style={{ background: 'var(--bg)' }}>
      <main
        className="relative flex min-h-screen flex-col items-center justify-center p-8"
        style={{ background: 'var(--bg)' }}
      >
        <form
          onSubmit={secondFactor ? login.verifySecondFactor : login.submit}
          className="card rise relative z-10 w-full max-w-sm p-8"
        >
          <h1 className="text-[24px] leading-tight" style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>
            {secondFactor ? 'Verify' : 'Sign in'}
          </h1>

          <p className="mt-2 text-[12px]" style={{ color: 'var(--text-mute)' }}>
            {secondFactor ? (
              'Enter the 6-digit code from your authenticator app.'
            ) : (
              <>
                Console access is restricted to <span style={{ color: 'var(--accent)' }}>admin</span> accounts.
              </>
            )}
          </p>

          {secondFactor ? (
            <SecondFactorField code={login.code} onCode={login.setCode} />
          ) : (
            <CredentialFields
              email={login.email}
              password={login.password}
              onEmail={login.setEmail}
              onPassword={login.setPassword}
            />
          )}

          {login.expired && !login.error && (
            <LoginNotice tone="amber">
              Your session expired and you were signed out. Sign in again to continue.
            </LoginNotice>
          )}

          {login.error && <LoginNotice tone="red">{login.error}</LoginNotice>}

          <button type="submit" disabled={login.loading} className="btn btn-primary mt-6 w-full justify-center py-3">
            {login.loading ? (
              submitLabel
            ) : (
              <>
                {submitLabel} <ArrowRight size={14} />
              </>
            )}
          </button>

          {secondFactor && (
            <button
              type="button"
              onClick={login.backToCredentials}
              className="mt-3 w-full text-center text-[11px] hover:underline"
              style={{ color: 'var(--text-mute)' }}
            >
              ← Back to sign in
            </button>
          )}

          <p className="mt-6 text-center text-[11px]" style={{ color: 'var(--text-mute)' }}>
            Build · {new Date().getFullYear()} · v1.0
          </p>
        </form>
      </main>

      {/* The grid always declared this second column and nothing ever filled it.
          It also never rendered: `grid-cols-[55fr,45fr]` is a no-op in Tailwind
          v4 (a comma is not a valid track separator), so the page was one
          column and the aside would have stacked below the fold. Underscores. */}
      <aside
        className="relative hidden flex-col items-center justify-center gap-6 p-12 text-center lg:flex"
        style={{ background: 'var(--surface-2)', borderLeft: '1px solid var(--border)' }}
      >
        <Mascot name={secondFactor ? 'shield-keylock' : 'coding-deploying'} size={200} float />
        <div className="max-w-xs space-y-2">
          <p className="display-heading text-[18px]" style={{ color: 'var(--text)' }}>
            {secondFactor ? 'One more step' : 'Your backend, all of it'}
          </p>
          <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
            {secondFactor
              ? 'Second factor keeps the console yours even if the password leaks.'
              : 'Postgres, auth, storage, realtime and edge functions behind one console.'}
          </p>
        </div>
      </aside>
    </div>
  );
}
