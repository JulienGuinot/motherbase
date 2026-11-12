'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { MotherbaseClient, Passkey } from '@motherbase/client';
import { useAuth, useMotherbaseClient } from './context.js';
import { classes, Field, FormShell, Notice, useFormAction } from './shared.js';
import type { AuthClassNames, SubmitEvent } from './shared.js';
import { UserAvatar } from './avatar.js';
import type { UserAvatarProps } from './avatar.js';
import { AvatarUpload } from './upload.js';
import type { AvatarUploadProps } from './upload.js';

/** The `secret` query parameter of an otpauth:// URI, for manual entry. */
function secretFromUri(uri: string): string {
  return new URL(uri).searchParams.get('secret') ?? '';
}

const userButtonLabels = {
  profile: 'Profile',
  security: 'Security',
  signOut: 'Sign out',
};

const profileLabels = {
  title: 'Profile',
  firstName: 'First name',
  lastName: 'Last name',
  submit: 'Save profile',
  submitting: 'Saving…',
  saved: 'Profile saved.',
};

const passkeyManagerLabels = {
  title: 'Passkeys',
  description: 'Use a device passkey to sign in without a password.',
  loading: 'Loading passkeys…',
  empty: 'No passkeys yet.',
  unnamed: 'Passkey',
  remove: 'Remove',
  confirmRemove: 'Confirm removal',
  cancel: 'Cancel',
  add: 'Add a passkey',
  working: 'Working…',
};

const mfaSettingsLabels = {
  title: 'Two-factor authentication',
  description: 'Protect your account with an authenticator app.',
  checking: 'Checking security settings…',
  enabled: 'Two-factor authentication is on.',
  disablePassword: 'Password to turn off',
  disable: 'Turn off two-factor authentication',
  updating: 'Updating…',
  password: 'Password',
  enable: 'Set up two-factor authentication',
  preparing: 'Preparing…',
  qrAlt: 'Scan with your authenticator app',
  openApp: 'Open authenticator app',
  secretHint: 'Or enter this secret in your authenticator app:',
  code: 'Verification code',
  verify: 'Verify authenticator',
  verifying: 'Verifying…',
  saveCodes: 'Save these recovery codes. They will not be shown again.',
  codesSaved: "I've saved the codes",
};

export type UserButtonLabels = typeof userButtonLabels;
export type UserProfileLabels = typeof profileLabels;
export type PasskeyManagerLabels = typeof passkeyManagerLabels;
export type MfaSettingsLabels = typeof mfaSettingsLabels;

export type UserButtonClassNames = Partial<Record<'trigger' | 'avatar' | 'name' | 'panel', string>>;

/** A menu line: a link when it has an `href`, otherwise a button. */
export interface UserMenuItem {
  label: ReactNode;
  href?: string;
  onClick?: () => void;
  icon?: ReactNode;
}

export function UserButton({ profileHref, securityHref, onSignOut, className, classNames, avatar, showName = true, labels, items, children }: {
  profileHref?: string;
  securityHref?: string;
  onSignOut?: () => void;
  className?: string;
  classNames?: UserButtonClassNames;
  /** Forwarded to the avatar: `size`, `src`, `fallback`... */
  avatar?: Omit<UserAvatarProps, 'user'>;
  showName?: boolean;
  labels?: Partial<UserButtonLabels>;
  /** Custom lines, rendered after Profile and Security. */
  items?: UserMenuItem[];
  /** Anything else for the menu, rendered above Sign out. */
  children?: ReactNode;
}) {
  const { user, loading, signOut } = useAuth();
  const { busy, error, run } = useFormAction();
  if (loading || !user) return null;
  const text = { ...userButtonLabels, ...labels };

  async function leave() {
    await run(async () => {
      await signOut();
      onSignOut?.();
      return { error: null };
    });
  }

  const label = user.name || user.email;
  return <details className={classes('mbui mbui-user-menu', className)}>
    <summary className={classes('mbui-user-trigger', classNames?.trigger)} aria-label={showName ? undefined : label}>
      <UserAvatar user={user} {...avatar} className={classes(avatar?.className, classNames?.avatar)} />
      {showName && <span className={classNames?.name}>{label}</span>}</summary>
    <div className={classes('mbui-menu-panel', classNames?.panel)}>
      <p className="mbui-menu-email">{user.email}</p>
      {profileHref && <a href={profileHref}>{text.profile}</a>}
      {securityHref && <a href={securityHref}>{text.security}</a>}
      {items?.map((item, index) => item.href
        ? <a key={index} href={item.href} onClick={item.onClick}>{item.icon}{item.label}</a>
        : <button key={index} type="button" onClick={item.onClick}>{item.icon}{item.label}</button>)}
      {children}
      <button type="button" disabled={busy} onClick={() => void leave()}>{text.signOut}</button>
      <Notice error>{error}</Notice>
    </div>
  </details>;
}

export function UserProfileForm({ className, classNames, onSaved, avatar, avatarUpload, labels }: {
  className?: string;
  classNames?: AuthClassNames;
  onSaved?: () => void;
  /** Forwarded to the avatar shown above the form; `false` hides it. */
  avatar?: Omit<UserAvatarProps, 'user'> | false;
  /** Lets the user change their picture. Options of `AvatarUpload`. */
  avatarUpload?: Omit<AvatarUploadProps, 'avatar'>;
  labels?: Partial<UserProfileLabels>;
}) {
  const { client, user } = useAuth();
  const [firstName, setFirstName] = useState(user?.firstName ?? '');
  const [lastName, setLastName] = useState(user?.lastName ?? '');
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useFormAction();
  const text = { ...profileLabels, ...labels };

  useEffect(() => setFirstName(user?.firstName ?? ''), [user?.firstName]);
  useEffect(() => setLastName(user?.lastName ?? ''), [user?.lastName]);

  // The structured name, not `name`: the server derives `name` from these two
  // and refuses a `name` written alone over them.
  async function save(event: SubmitEvent) {
    event.preventDefault();
    const result = await run(() => client.auth.updateUser({ firstName: firstName.trim(), lastName: lastName.trim() }));
    if (result) {
      setSaved(true);
      onSaved?.();
    }
  }

  const leading = avatar === false || !user ? undefined
    : avatarUpload ? <AvatarUpload {...avatarUpload} avatar={avatar} />
    : <UserAvatar user={user} size={56} {...avatar} />;

  return <FormShell title={text.title} description={user?.email} leading={leading} className={className} classNames={classNames}>
    <form onSubmit={event => void save(event)} className={classes('mbui-form', classNames?.form)}>
      <Field label={text.firstName} name="firstName" value={firstName} onChange={value => { setFirstName(value); setSaved(false); }} autoComplete="given-name" classNames={classNames} />
      <Field label={text.lastName} name="lastName" value={lastName} onChange={value => { setLastName(value); setSaved(false); }} autoComplete="family-name" classNames={classNames} required={false} />
      <Notice error className={classNames?.message}>{error}</Notice>
      <Notice className={classNames?.message}>{saved ? text.saved : null}</Notice>
      <button type="submit" disabled={busy || !user} className={classes('mbui-button mbui-button-primary', classNames?.button)}>{busy ? text.submitting : text.submit}</button>
    </form>
  </FormShell>;
}

export function PasskeyManager({ client: suppliedClient, className, classNames, labels }: {
  client?: MotherbaseClient;
  className?: string;
  classNames?: AuthClassNames;
  labels?: Partial<PasskeyManagerLabels>;
}) {
  const client = useMotherbaseClient(suppliedClient);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const { busy, error, setError, run } = useFormAction();
  const text = { ...passkeyManagerLabels, ...labels };

  const load = useCallback(async () => {
    const result = await client.auth.passkey.listUserPasskeys();
    if (result.error) setError(result.error.message || result.error.statusText);
    else setPasskeys(result.data ?? []);
    setLoading(false);
  }, [client, setError]);

  useEffect(() => void load(), [load]);

  async function register() {
    if (await run(() => client.auth.passkey.addPasskey())) await load();
  }

  async function remove(id: string) {
    const result = await run(() => client.auth.passkey.deletePasskey({ id }));
    if (result) {
      setPasskeys(current => current.filter(passkey => passkey.id !== id));
      setConfirmId(null);
    }
  }

  return <FormShell title={text.title} description={text.description} className={className} classNames={classNames}>
    <Notice error className={classNames?.message}>{error}</Notice>
    {loading ? <p className="mbui-description" role="status">{text.loading}</p> : passkeys.length === 0 ? <p className="mbui-description">{text.empty}</p> : (
      <ul className="mbui-item-list">
        {passkeys.map(passkey => <li key={passkey.id}>
          <span>{passkey.name || text.unnamed}</span>
          {confirmId === passkey.id ? <span className="mbui-item-actions"><button type="button" disabled={busy} onClick={() => void remove(passkey.id)}>{text.confirmRemove}</button><button type="button" onClick={() => setConfirmId(null)}>{text.cancel}</button></span> : <button type="button" onClick={() => setConfirmId(passkey.id)}>{text.remove}</button>}
        </li>)}
      </ul>
    )}
    <button type="button" disabled={busy} className={classes('mbui-button mbui-button-secondary', classNames?.secondaryButton)} onClick={() => void register()}>{busy ? text.working : text.add}</button>
  </FormShell>;
}

export function MfaSettings({ client: suppliedClient, renderQr, className, classNames, labels }: {
  client?: MotherbaseClient;
  renderQr?: (uri: string) => ReactNode;
  className?: string;
  classNames?: AuthClassNames;
  labels?: Partial<MfaSettingsLabels>;
}) {
  const client = useMotherbaseClient(suppliedClient);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [enrollment, setEnrollment] = useState<{ uri: string; secret: string; backupCodes: string[] } | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const { busy, error, setError, run } = useFormAction();
  const text = { ...mfaSettingsLabels, ...labels };

  useEffect(() => {
    let active = true;
    void client.auth.getSession().then(result => {
      if (!active) return;
      if (result.error) setError(result.error.message || result.error.statusText);
      else setEnabled(Boolean(result.data?.user.twoFactorEnabled));
    });
    return () => { active = false; };
  }, [client, setError]);

  useEffect(() => {
    if (!enrollment || renderQr) return;
    let active = true;
    void import('qrcode').then(qr => qr.toDataURL(enrollment.uri, { width: 180, margin: 1 }))
      .then(url => { if (active) setQrUrl(url); })
      .catch(() => { if (active) setQrUrl(null); });
    return () => { active = false; };
  }, [enrollment, renderQr]);

  async function enroll(event: SubmitEvent) {
    event.preventDefault();
    const result = await run(() => client.auth.twoFactor.enable({ password }));
    // Better Auth 1.7 also answers `{ method: 'otp' }` for email/SMS codes; this
    // form only enrolls an authenticator app.
    if (result?.data && 'totpURI' in result.data) {
      const uri = result.data.totpURI;
      setVerified(false);
      setCode('');
      setQrUrl(null);
      setEnrollment({ uri, secret: secretFromUri(uri), backupCodes: result.data.backupCodes });
      setPassword('');
    }
  }

  async function verify(event: SubmitEvent) {
    event.preventDefault();
    const result = await run(() => client.auth.twoFactor.verifyTotp({ code: code.trim() }));
    if (result) {
      setEnabled(true);
      setVerified(true);
      setCode('');
    }
  }

  async function disable(event: SubmitEvent) {
    event.preventDefault();
    const result = await run(() => client.auth.twoFactor.disable({ password }));
    if (result) {
      setEnabled(false);
      setVerified(false);
      setPassword('');
    }
  }

  const form = classes('mbui-form', classNames?.form);
  return <FormShell title={text.title} description={text.description} className={className} classNames={classNames}>
    <Notice error className={classNames?.message}>{error}</Notice>
    {enabled === null && !error && <p className="mbui-description" role="status">{text.checking}</p>}
    {enabled && !enrollment && <form onSubmit={event => void disable(event)} className={form}>
      <p className="mbui-description">{text.enabled}</p>
      <Field label={text.disablePassword} name="password" type="password" value={password} onChange={setPassword} autoComplete="current-password" classNames={classNames} />
      <button type="submit" disabled={busy} className={classes('mbui-button mbui-button-secondary', classNames?.secondaryButton)}>{busy ? text.updating : text.disable}</button>
    </form>}
    {enabled === false && !enrollment && <form onSubmit={event => void enroll(event)} className={form}>
      <Field label={text.password} name="password" type="password" value={password} onChange={setPassword} autoComplete="current-password" classNames={classNames} />
      <button type="submit" disabled={busy} className={classes('mbui-button mbui-button-primary', classNames?.button)}>{busy ? text.preparing : text.enable}</button>
    </form>}
    {enrollment && <div className="mbui-form">
      {!verified && <>
        {renderQr ? renderQr(enrollment.uri) : qrUrl ? <img src={qrUrl} alt={text.qrAlt} width={180} height={180} /> : null}
        <a href={enrollment.uri} className="mbui-text-button">{text.openApp}</a>
        <p className="mbui-description">{text.secretHint}</p>
        <code className="mbui-secret">{enrollment.secret}</code>
        <form onSubmit={event => void verify(event)} className={form}>
          <Field label={text.code} name="code" value={code} onChange={setCode} autoComplete="one-time-code" classNames={classNames} />
          <button type="submit" disabled={busy} className={classes('mbui-button mbui-button-primary', classNames?.button)}>{busy ? text.verifying : text.verify}</button>
        </form>
      </>}
      {verified && <>
        <p className="mbui-description">{text.saveCodes}</p>
        <ul className="mbui-code-list">{enrollment.backupCodes.map(backupCode => <li key={backupCode}><code>{backupCode}</code></li>)}</ul>
        <button type="button" className={classes('mbui-button mbui-button-secondary', classNames?.secondaryButton)} onClick={() => setEnrollment(null)}>{text.codesSaved}</button>
      </>}
    </div>}
  </FormShell>;
}

export function SecurityPanel({ passkeys = true, mfa = true, renderQr, className, classNames, labels }: {
  passkeys?: boolean;
  mfa?: boolean;
  renderQr?: (uri: string) => ReactNode;
  className?: string;
  /** Applied to both cards. */
  classNames?: AuthClassNames;
  labels?: { passkeys?: Partial<PasskeyManagerLabels>; mfa?: Partial<MfaSettingsLabels> };
}) {
  return <div className={classes('mbui mbui-stack', className)}>
    {passkeys && <PasskeyManager classNames={classNames} labels={labels?.passkeys} />}
    {mfa && <MfaSettings renderQr={renderQr} classNames={classNames} labels={labels?.mfa} />}
  </div>;
}
