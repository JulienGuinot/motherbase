'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { describeError } from '@/shared/lib/errors';
import { auth } from '@/shared/lib/auth';
import { useOrgs } from '@/shared/lib/org';
import { sessionApi } from '@/features/auth/api/session.api';

/**
 * On this one screen a 401 does not mean "your session lapsed", it means the
 * credentials were wrong, so the generic status wording would misdirect. A
 * server message (rate limiting, disabled account, 2FA) still wins.
 */
function loginErrorMessage(error: unknown): string {
  const info = describeError(error, 'Sign-in failed.');
  if (info.status === 401 || info.status === 403) {
    const generic = /^(unauthorized|forbidden)\.?$/i.test(info.message);
    if (
      generic ||
      info.message === 'Your session is no longer valid.' ||
      info.message === 'You do not have permission to do this.'
    ) {
      return 'Incorrect email or password, or the account is not a console admin.';
    }
  }
  if (info.offline) return `${info.message} ${info.hint ?? ''}`.trim();
  return info.message;
}

/**
 * Sign-in to the Platform Console, which authenticates against the platform
 * admin and may require a second factor.
 */
export function useLogin() {
  const router = useRouter();
  const { reload: reloadOrgs } = useOrgs();

  // Read once on mount: an involuntary sign-out otherwise drops the user here
  // with no explanation for the work they just lost.
  const [expired] = useState(() => auth.takeSignOutReason() === 'expired');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [needsSecondFactor, setNeedsSecondFactor] = useState(false);
  const [mustChangeAfterSecondFactor, setMustChangeAfterSecondFactor] = useState(false);

  async function finishConsoleLogin(token: string, mustChangePassword: boolean) {
    auth.set(token, undefined, { mustChangePassword });
    if (mustChangePassword) {
      router.replace('/password-change-required');
      return;
    }
    await reloadOrgs();
    router.push('/');
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const data = await sessionApi.consoleLogin(email, password);
      const result = data.data ?? data;
      const mustChangePassword = Boolean(result.mustChangePassword);
      if (result.token) {
        // The backend stays authoritative on every protected request. This
        // persisted flag only prevents blocked org calls during routing.
        await finishConsoleLogin(result.token, mustChangePassword);
      } else if (result.twoFactor) {
        // Keep the first-step flag while Better Auth completes the challenge.
        setMustChangeAfterSecondFactor(mustChangePassword);
        setNeedsSecondFactor(true);
      } else {
        throw new Error('No token returned');
      }
    } catch (err) {
      auth.clear();
      setError(loginErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const verifySecondFactor = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { token } = await sessionApi.verifyConsole2fa(code.trim());
      if (!token) throw new Error('No token returned');
      await finishConsoleLogin(token, mustChangeAfterSecondFactor);
    } catch {
      setError('Invalid authentication code.');
    } finally {
      setLoading(false);
    }
  };

  return {
    expired,
    email,
    setEmail,
    password,
    setPassword,
    code,
    // A TOTP code is digits only, and never longer than a backup code.
    setCode: (value: string) => setCode(value.replace(/\D/g, '').slice(0, 8)),
    error,
    loading,
    needsSecondFactor,
    submit,
    verifySecondFactor,
    backToCredentials: () => {
      setNeedsSecondFactor(false);
      setMustChangeAfterSecondFactor(false);
      setCode('');
      setError(null);
    },
  };
}
