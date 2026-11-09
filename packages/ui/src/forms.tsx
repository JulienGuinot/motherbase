'use client';

import { useEffect, useRef, useState } from 'react';
import type { MotherbaseClient, Session } from '@motherbase/client';
import { useMotherbaseClient } from './context.js';
import { classes, Field, FormShell, Notice, useFormAction } from './shared.js';
import type { AuthClassNames, AuthSlots, SubmitEvent } from './shared.js';

const signUpLabels = {
  title: 'Create an account',
  description: 'Use your email to get started.',
  email: 'Email',
  password: 'Password',
  submit: 'Create account',
  submitting: 'Creating account…',
  ready: 'Your account is ready.',
  checkEmail: 'Check your email to finish creating your account.',
};

const forgotPasswordLabels = {
  title: 'Reset your password',
  description: "We'll email you a code if this address has an account.",
  email: 'Email',
  submit: 'Send reset code',
  submitting: 'Sending…',
  sent: 'Check your email for a reset code.',
};

const resetPasswordLabels = {
  title: 'Choose a new password',
  description: 'Enter the code from your email.',
  email: 'Email',
  code: 'Reset code',
  password: 'New password',
  submit: 'Update password',
  submitting: 'Updating…',
  done: 'Password updated. You can sign in now.',
};

const callbackLabels = {
  title: 'Finishing sign in',
  checking: 'Checking your session…',
  complete: 'Sign in complete.',
  noSession: 'No sign-in session was found in this callback.',
  failed: 'Sign-in could not be completed.',
};

export type SignUpLabels = typeof signUpLabels;
export type ForgotPasswordLabels = typeof forgotPasswordLabels;
export type ResetPasswordLabels = typeof resetPasswordLabels;
export type AuthCallbackLabels = typeof callbackLabels;

interface FormProps<Labels> {
  client?: MotherbaseClient;
  className?: string;
  classNames?: AuthClassNames;
  slots?: AuthSlots;
  labels?: Partial<Labels>;
}

async function waitForRedirectSession(client: MotherbaseClient): Promise<Session | null> {
  const current = await client.hydrate();
  if (current) return current;

  // The SDK may already be completing this redirect automatically. In that
  // case it has removed the URL token, and its SIGNED_IN event is the result.
  return new Promise(resolve => {
    const subscription = client.auth.onAuthStateChange((_event, session) => {
      if (!session) return;
      clearTimeout(timer);
      subscription.unsubscribe();
      resolve(session);
    }).data.subscription;
    const timer = setTimeout(() => {
      subscription.unsubscribe();
      resolve(null);
    }, 10_000);
  });
}

export function SignUpForm({ client: suppliedClient, onSuccess, className, classNames, slots, labels }: FormProps<SignUpLabels> & { onSuccess?: (session: Session | null) => void }) {
  const client = useMotherbaseClient(suppliedClient);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const { busy, error, run } = useFormAction();
  const text = { ...signUpLabels, ...labels };

  async function signUp(event: SubmitEvent) {
    event.preventDefault();
    const result = await run(() => client.auth.signUp.email({ email: email.trim(), password, name: email.trim() }));
    if (!result) return;
    // No token: the project requires email verification before a session.
    const session = result.data?.token ? await client.hydrate() : null;
    setMessage(session ? text.ready : text.checkEmail);
    onSuccess?.(session);
  }

  return (
    <FormShell title={text.title} description={text.description} leading={slots?.logo} footer={slots?.footer} className={className} classNames={classNames}>
      <form onSubmit={event => void signUp(event)} className={classes('mbui-form', classNames?.form)}>
        <Field label={text.email} name="email" type="email" value={email} onChange={setEmail} autoComplete="email" classNames={classNames} />
        <Field label={text.password} name="password" type="password" value={password} onChange={setPassword} autoComplete="new-password" classNames={classNames} />
        <Notice error className={classNames?.message}>{error}</Notice>
        <Notice className={classNames?.message}>{message}</Notice>
        <button type="submit" disabled={busy} className={classes('mbui-button mbui-button-primary', classNames?.button)}>{busy ? text.submitting : text.submit}</button>
      </form>
    </FormShell>
  );
}

export function ForgotPasswordForm({ client: suppliedClient, onSent, className, classNames, slots, labels }: FormProps<ForgotPasswordLabels> & { onSent?: (email: string) => void }) {
  const client = useMotherbaseClient(suppliedClient);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useFormAction();
  const text = { ...forgotPasswordLabels, ...labels };

  async function requestReset(event: SubmitEvent) {
    event.preventDefault();
    const result = await run(() => client.auth.emailOtp.requestPasswordReset({ email: email.trim() }));
    if (result) {
      setSent(true);
      onSent?.(email.trim());
    }
  }

  return (
    <FormShell title={text.title} description={text.description} leading={slots?.logo} footer={slots?.footer} className={className} classNames={classNames}>
      <form onSubmit={event => void requestReset(event)} className={classes('mbui-form', classNames?.form)}>
        <Field label={text.email} name="email" type="email" value={email} onChange={setEmail} autoComplete="email" classNames={classNames} />
        <Notice error className={classNames?.message}>{error}</Notice>
        <Notice className={classNames?.message}>{sent ? text.sent : null}</Notice>
        <button type="submit" disabled={busy} className={classes('mbui-button mbui-button-primary', classNames?.button)}>{busy ? text.submitting : text.submit}</button>
      </form>
    </FormShell>
  );
}

export function ResetPasswordForm({ client: suppliedClient, initialEmail = '', onSuccess, className, classNames, slots, labels }: FormProps<ResetPasswordLabels> & { initialEmail?: string; onSuccess?: () => void }) {
  const client = useMotherbaseClient(suppliedClient);
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, run } = useFormAction();
  const text = { ...resetPasswordLabels, ...labels };

  async function reset(event: SubmitEvent) {
    event.preventDefault();
    const result = await run(() => client.auth.emailOtp.resetPassword({ email: email.trim(), otp: code.trim(), password }));
    if (result) {
      setDone(true);
      onSuccess?.();
    }
  }

  return (
    <FormShell title={text.title} description={text.description} leading={slots?.logo} footer={slots?.footer} className={className} classNames={classNames}>
      <form onSubmit={event => void reset(event)} className={classes('mbui-form', classNames?.form)}>
        <Field label={text.email} name="email" type="email" value={email} onChange={setEmail} autoComplete="email" classNames={classNames} />
        <Field label={text.code} name="code" value={code} onChange={setCode} autoComplete="one-time-code" classNames={classNames} />
        <Field label={text.password} name="password" type="password" value={password} onChange={setPassword} autoComplete="new-password" classNames={classNames} />
        <Notice error className={classNames?.message}>{error}</Notice>
        <Notice className={classNames?.message}>{done ? text.done : null}</Notice>
        <button type="submit" disabled={busy || done} className={classes('mbui-button mbui-button-primary', classNames?.button)}>{busy ? text.submitting : text.submit}</button>
      </form>
    </FormShell>
  );
}

/** Complete either an implicit OAuth redirect or a PKCE code exchange. */
export function AuthCallback({ client: suppliedClient, onSuccess, className, classNames, slots, labels }: FormProps<AuthCallbackLabels> & { onSuccess?: (session: Session) => void }) {
  const client = useMotherbaseClient(suppliedClient);
  const attempt = useRef<Promise<{ session: Session | null; error: string | null }> | null>(null);
  const delivered = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const text = { ...callbackLabels, ...labels };
  const { noSession, failed } = text;

  useEffect(() => {
    let active = true;
    if (!attempt.current) {
      const url = new URL(window.location.href);
      const providerError = url.searchParams.get('error');
      if (providerError) {
        attempt.current = Promise.resolve({ session: null, error: providerError });
      } else {
        const code = url.searchParams.get('code');
        if (code) {
          url.searchParams.delete('code');
          window.history.replaceState(window.history.state, '', url.toString());
        }
        attempt.current = (async () => {
          if (code) {
            const result = await client.auth.exchangeCodeForSession(code);
            return { session: result.data?.session ?? null, error: result.error?.message ?? null };
          }
          if (window.location.hash.includes('access_token=')) {
            const result = await client.auth.getSessionFromUrl();
            return { session: result.data?.session ?? null, error: result.error?.message ?? null };
          }
          return { session: await waitForRedirectSession(client), error: null };
        })();
      }
    }
    void attempt.current.then(result => {
      if (!active) return;
      if (result.error) setError(result.error);
      else if (result.session) {
        setComplete(true);
        if (!delivered.current) {
          delivered.current = true;
          onSuccess?.(result.session);
        }
      }
      else setError(noSession);
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : failed);
    });
    return () => { active = false; };
  }, [client, onSuccess, noSession, failed]);

  return <FormShell title={text.title} leading={slots?.logo} footer={slots?.footer} className={className} classNames={classNames}>
    <Notice error className={classNames?.message}>{error}</Notice>
    {!error && <p className={classes('mbui-description', classNames?.description)} role="status">{complete ? text.complete : text.checking}</p>}
  </FormShell>;
}
