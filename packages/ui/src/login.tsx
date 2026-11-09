'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { MotherbaseClient, Session } from '@motherbase/client';
import { useMotherbaseClient } from './context.js';
import { classes, Field, FormShell, Notice, useFormAction } from './shared.js';
import type { AuthClassNames, AuthSlots, SubmitEvent } from './shared.js';

export interface OAuthProvider {
  id: string;
  label?: string;
  icon?: ReactNode;
}

const oauthLabels = {
  continueWith: (provider: string): ReactNode => `Continue with ${provider}`,
};

const passkeyLabels = {
  passkey: 'Continue with passkey',
  passkeyWaiting: 'Waiting for passkey…',
};

const mfaLabels = {
  title: 'Verify your identity',
  description: 'Enter a code to finish signing in.',
  methods: 'Verification method',
  authenticator: 'Authenticator',
  oneTimeCode: 'One-time code',
  recoveryCode: 'Recovery code',
  sendCode: 'Send a code',
  resendCode: 'Send another code',
  code: 'Verification code',
  submit: 'Verify and sign in',
  submitting: 'Verifying…',
  back: 'Back to sign in',
  noMethod: 'No verification method is available for this account.',
  noSession: 'Verification completed without a session. Please sign in again.',
};

const loginLabels = {
  title: 'Sign in',
  description: 'Access your account.',
  email: 'Email',
  password: 'Password',
  submit: 'Sign in',
  submitting: 'Signing in…',
  or: 'or',
  ...oauthLabels,
  ...passkeyLabels,
};

export type OAuthLabels = typeof oauthLabels;
export type PasskeyLabels = typeof passkeyLabels;
export type MfaLabels = typeof mfaLabels;
export type LoginLabels = typeof loginLabels & { mfa?: Partial<MfaLabels> };

export interface LoginFormProps {
  client?: MotherbaseClient;
  providers?: Array<string | OAuthProvider>;
  passkeys?: boolean;
  password?: boolean;
  oauthRedirectTo?: string;
  onSuccess?: (session: Session) => void;
  className?: string;
  classNames?: AuthClassNames;
  slots?: AuthSlots;
  labels?: Partial<LoginLabels>;
}

export function OAuthButtons({ providers, onChoose, disabled = false, classNames, labels }: {
  providers: Array<string | OAuthProvider>;
  onChoose: (provider: string) => void;
  disabled?: boolean;
  classNames?: AuthClassNames;
  labels?: Partial<OAuthLabels>;
}) {
  const text = { ...oauthLabels, ...labels };
  return (
    <div className="mbui-provider-list">
      {providers.map(entry => {
        const provider = typeof entry === 'string' ? { id: entry } : entry;
        const label = provider.label ?? provider.id.replace(/(^|-)(\w)/g, (_match, _separator, letter: string) => ` ${letter.toUpperCase()}`).trim();
        return (
          <button key={provider.id} type="button" disabled={disabled} className={classes('mbui-button mbui-button-secondary', classNames?.secondaryButton)} onClick={() => onChoose(provider.id)}>
            {provider.icon}<span>{text.continueWith(label)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function PasskeyButton({ client: suppliedClient, onSuccess, className, classNames, labels }: {
  client?: MotherbaseClient;
  onSuccess?: (session: Session) => void;
  className?: string;
  classNames?: AuthClassNames;
  labels?: Partial<PasskeyLabels>;
}) {
  const client = useMotherbaseClient(suppliedClient);
  const { busy, error, run } = useFormAction();
  const text = { ...passkeyLabels, ...labels };

  async function signIn() {
    if (!await run(() => client.auth.signIn.passkey())) return;
    const session = await client.hydrate();
    if (session) onSuccess?.(session);
  }

  return (
    <div className={className}>
      <button type="button" disabled={busy} className={classes('mbui-button mbui-button-secondary', classNames?.secondaryButton)} onClick={() => void signIn()}>
        {busy ? text.passkeyWaiting : text.passkey}
      </button>
      <Notice error className={classNames?.message}>{error}</Notice>
    </div>
  );
}

export function MfaChallenge({ client: suppliedClient, methods, onSuccess, onBack, className, classNames, slots, labels }: {
  client?: MotherbaseClient;
  methods: string[];
  onSuccess?: (session: Session) => void;
  onBack?: () => void;
  className?: string;
  classNames?: AuthClassNames;
  slots?: AuthSlots;
  labels?: Partial<MfaLabels>;
}) {
  const client = useMotherbaseClient(suppliedClient);
  const available = methods.filter((method): method is 'totp' | 'otp' => method === 'totp' || method === 'otp');
  const [method, setMethod] = useState<'totp' | 'otp' | 'backup'>(available[0] ?? 'totp');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, setError, run } = useFormAction();
  const text = { ...mfaLabels, ...labels };

  async function sendCode() {
    if (await run(() => client.auth.twoFactor.sendOtp())) setSent(true);
  }

  async function verify(event: SubmitEvent) {
    event.preventDefault();
    const { twoFactor } = client.auth;
    const body = { code: code.trim() };
    const verified = await run(() => method === 'backup' ? twoFactor.verifyBackupCode(body)
      : method === 'otp' ? twoFactor.verifyOtp(body)
      : twoFactor.verifyTotp(body));
    if (!verified) return;
    const session = await client.hydrate();
    if (session) onSuccess?.(session);
    else setError(text.noSession);
  }

  return (
    <FormShell title={text.title} description={text.description} leading={slots?.logo} footer={slots?.footer} className={className} classNames={classNames}>
      <div className="mbui-methods" aria-label={text.methods}>
        {available.map(option => <button key={option} type="button" aria-pressed={method === option} className="mbui-method" onClick={() => { setMethod(option); setCode(''); }}>{option === 'totp' ? text.authenticator : text.oneTimeCode}</button>)}
        {available.length > 0 && <button type="button" aria-pressed={method === 'backup'} className="mbui-method" onClick={() => { setMethod('backup'); setCode(''); }}>{text.recoveryCode}</button>}
      </div>
      {available.length === 0 ? <Notice error className={classNames?.message}>{text.noMethod}</Notice> : (
        <form onSubmit={event => void verify(event)} className={classes('mbui-form', classNames?.form)}>
          {method === 'otp' && <button type="button" disabled={busy} className={classes('mbui-text-button', classNames?.secondaryButton)} onClick={() => void sendCode()}>{sent ? text.resendCode : text.sendCode}</button>}
          <Field label={method === 'backup' ? text.recoveryCode : text.code} name="code" value={code} onChange={setCode} autoComplete="one-time-code" classNames={classNames} />
          <Notice error className={classNames?.message}>{error}</Notice>
          <button type="submit" disabled={busy || !code.trim()} className={classes('mbui-button mbui-button-primary', classNames?.button)}>{busy ? text.submitting : text.submit}</button>
        </form>
      )}
      {onBack && <button type="button" className="mbui-text-button" onClick={onBack}>{text.back}</button>}
    </FormShell>
  );
}

export function LoginForm({ client: suppliedClient, providers = [], passkeys = false, password = true, oauthRedirectTo, onSuccess, className, classNames, slots, labels }: LoginFormProps) {
  const client = useMotherbaseClient(suppliedClient);
  const [email, setEmail] = useState('');
  const [secret, setSecret] = useState('');
  const [mfaMethods, setMfaMethods] = useState<string[] | null>(null);
  const { busy, error, run } = useFormAction();
  const text = { ...loginLabels, ...labels };

  async function signIn(event: SubmitEvent) {
    event.preventDefault();
    const result = await run(() => client.auth.signIn.email({ email: email.trim(), password: secret }));
    if (!result?.data) return;
    // The twoFactor plugin's answer while a second factor is pending. Better
    // Auth's sign-in type does not list it.
    const pending = result.data as { twoFactorRedirect?: boolean; twoFactorMethods?: string[] };
    if (pending.twoFactorRedirect) {
      setSecret('');
      setMfaMethods(pending.twoFactorMethods ?? []);
      return;
    }
    const session = await client.hydrate();
    if (session) onSuccess?.(session);
  }

  async function socialSignIn(provider: string) {
    await run(() => client.auth.signIn.social({ provider, callbackURL: oauthRedirectTo }));
  }

  if (mfaMethods) {
    return <MfaChallenge client={client} methods={mfaMethods} onSuccess={onSuccess} onBack={() => setMfaMethods(null)} className={className} classNames={classNames} slots={{ logo: slots?.logo }} labels={text.mfa} />;
  }

  return (
    <FormShell title={text.title} description={text.description} leading={slots?.logo} className={className} classNames={classNames} footer={slots?.footer}>
      {password && <form onSubmit={event => void signIn(event)} className={classes('mbui-form', classNames?.form)}>
        <Field label={text.email} name="email" type="email" value={email} onChange={setEmail} autoComplete="email" classNames={classNames} />
        <Field label={text.password} name="password" type="password" value={secret} onChange={setSecret} autoComplete="current-password" classNames={classNames} />
        <Notice error className={classNames?.message}>{error}</Notice>
        <button type="submit" disabled={busy} className={classes('mbui-button mbui-button-primary', classNames?.button)}>{busy ? text.submitting : text.submit}</button>
      </form>}
      {(providers.length > 0 || passkeys) && <div className="mbui-alternatives">
        {password && <div className="mbui-divider"><span>{text.or}</span></div>}
        <OAuthButtons providers={providers} onChoose={provider => void socialSignIn(provider)} disabled={busy} classNames={classNames} labels={text} />
        {passkeys && <PasskeyButton client={client} onSuccess={onSuccess} classNames={classNames} labels={text} />}
        {!password && <Notice error className={classNames?.message}>{error}</Notice>}
      </div>}
    </FormShell>
  );
}

export function LoginPage({ aside, ...props }: LoginFormProps & { aside?: ReactNode }) {
  return <main className="mbui mbui-page"><LoginForm {...props} />{aside && <aside className="mbui-aside">{aside}</aside>}</main>;
}
