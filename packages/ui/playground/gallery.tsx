import { useState } from 'react';
import type { MotherbaseClient } from '@motherbase/client';
import {
  AuthCallback, ForgotPasswordForm, LoginPage, MotherbaseProvider, ResetPasswordForm,
  SecurityPanel, SignUpForm, useAuth, UserButton, UserProfileForm,
} from '../src/index.js';
import { accountClient, demoUser, guestClient } from './mock.js';

type View = 'login' | 'signup' | 'recovery' | 'account' | 'security';
type Theme = 'forest' | 'ocean' | 'violet';

export interface PreviewConnection {
  mode: 'demo' | 'live';
  client: MotherbaseClient;
  authClient: MotherbaseClient;
  providers: string[];
  passkeys: boolean;
  url?: string;
}

const demoConnection: PreviewConnection = {
  mode: 'demo',
  client: accountClient,
  authClient: guestClient,
  providers: ['google', 'github'],
  passkeys: true,
};

const views: Array<{ id: View; number: string; label: string; components: string; description: string }> = [
  { id: 'login', number: '01', label: 'Sign in', components: 'LoginPage · MfaChallenge', description: 'A complete sign-in page, with configurable methods and a server-driven second factor.' },
  { id: 'signup', number: '02', label: 'Sign up', components: 'SignUpForm', description: 'A ready-to-use sign-up form, including the email verification state.' },
  { id: 'recovery', number: '03', label: 'Recovery', components: 'ForgotPasswordForm · ResetPasswordForm', description: 'The request and completion steps for a password reset.' },
  { id: 'account', number: '04', label: 'Account', components: 'UserButton · UserProfileForm', description: 'Identity display and profile editing for a signed-in user.' },
  { id: 'security', number: '05', label: 'Security', components: 'PasskeyManager · MfaSettings', description: 'Passkeys and two-factor setup, with a demo enrollment flow.' },
];

function Sidebar({ view, connection, onViewChange }: {
  view: View;
  connection: PreviewConnection;
  onViewChange: (view: View) => void;
}) {
  return (
    <aside className="gallery-sidebar">
      <div className="gallery-brand">
        <span className="gallery-brand-mark">m</span>
        <span>motherbase<small>UI / PLAYGROUND</small></span>
      </div>
      <div className="gallery-nav-label">COMPONENTS</div>
      <nav className="gallery-nav" aria-label="Components">
        {views.map(item => (
          <button key={item.id} type="button"
            aria-label={item.label}
            className={view === item.id ? 'active' : ''}
            aria-current={view === item.id ? 'page' : undefined}
            onClick={() => onViewChange(item.id)}>
            <span className="gallery-nav-number">{item.number}</span>
            <span>{item.label}</span>
            <span className="gallery-nav-arrow" aria-hidden="true">↗</span>
          </button>
        ))}
      </nav>
      <div className="gallery-sidebar-foot">
        <span className="gallery-status-dot" />{connection.mode === 'live' ? 'Live Motherbase' : 'Local demo data'}<br />
        <small>{connection.mode === 'live' ? new URL(connection.url!).host : 'No backend connection'}</small>
      </div>
    </aside>
  );
}

function Preview({ view, connection, showProviders, showPasskeys, onViewChange }: {
  view: View;
  connection: PreviewConnection;
  showProviders: boolean;
  showPasskeys: boolean;
  onViewChange: (view: View) => void;
}) {
  const { user, loading } = useAuth();
  const [signedIn, setSignedIn] = useState<string | null>(null);
  const isLive = connection.mode === 'live';
  const search = new URLSearchParams(window.location.search);
  const hasAuthCallback = isLive && (search.has('code') || search.has('error')
    || window.location.hash.includes('access_token='));

  if (hasAuthCallback) {
    return <div className="gallery-forms">
      <AuthCallback client={connection.client} onSuccess={() => onViewChange('account')} />
    </div>;
  }

  if (isLive && (view === 'account' || view === 'security') && (loading || !user)) {
    return <div className="gallery-state mbui">
      <h2>{loading ? 'Checking your session…' : 'Sign in to continue'}</h2>
      {!loading && <button type="button" onClick={() => onViewChange('login')}>Go to sign in</button>}
    </div>;
  }

  if (view === 'login') {
    if (!isLive && signedIn) {
      return (
        <div className="gallery-success mbui">
          <span className="gallery-success-icon">✓</span>
          <h2>Signed in</h2>
          <p>{signedIn}</p>
          <button type="button" onClick={() => setSignedIn(null)}>Back to sign in</button>
        </div>
      );
    }
    return (
      <LoginPage
        client={connection.authClient}
        providers={showProviders ? connection.providers : []}
        passkeys={showPasskeys}
        oauthRedirectTo={isLive ? `${window.location.origin}/` : undefined}
        onSuccess={session => isLive ? onViewChange('account') : setSignedIn(session.user.email)}
        slots={{
          logo: <span className="gallery-form-brand">◈ NORTHSTAR</span>,
          footer: isLive
            ? <span>Connected to <strong>{new URL(connection.url!).host}</strong></span>
            : <span>Preview account: <strong>demo@example.com</strong></span>,
        }}
        aside={
          <div className="gallery-login-aside">
            <span>YOUR NEXT IDEA STARTS HERE</span>
            <h2>Welcome<br />back.</h2>
            <p>One secure entry point for every application you build.</p>
          </div>
        }
      />
    );
  }

  if (view === 'signup') {
    return <div className="gallery-forms">
      <SignUpForm client={connection.authClient} />
      <p className="gallery-form-note">{isLive ? 'The account is created on your Motherbase instance.' : 'The demo shows the email verification state after submission.'}</p>
    </div>;
  }
  if (view === 'recovery') {
    return <div className="gallery-forms gallery-forms-pair">
      <ForgotPasswordForm client={connection.authClient} />
      <ResetPasswordForm client={connection.authClient} initialEmail={isLive ? '' : 'demo@example.com'} />
    </div>;
  }
  if (view === 'account') {
    return <div className="gallery-forms">
      <div className="gallery-user-row">
        <span>Signed-in user</span>
        <UserButton profileHref="#profile" securityHref="#security" />
      </div>
      <UserProfileForm />
      <p className="gallery-form-note">{isLive ? 'Profile changes are saved to your Motherbase instance.' : 'Changes stay in this browser preview. Reload to reset the demo.'}</p>
    </div>;
  }
  return <div className="gallery-forms gallery-security">
    <SecurityPanel />
    <p className="gallery-form-note">{isLive
      ? 'Security changes affect your signed-in account. Save your real recovery codes.'
      : <>Use any password to start MFA setup, then enter <strong>123456</strong>. Passkey registration needs a real WebAuthn backend.</>}
    </p>
  </div>;
}

function Controls({ view, theme, connection, showProviders, showPasskeys, onThemeChange, onProvidersChange, onPasskeysChange }: {
  view: View;
  theme: Theme;
  connection: PreviewConnection;
  showProviders: boolean;
  showPasskeys: boolean;
  onThemeChange: (theme: Theme) => void;
  onProvidersChange: (show: boolean) => void;
  onPasskeysChange: (show: boolean) => void;
}) {
  return (
    <aside className="gallery-controls" aria-label="Preview controls">
      <div className="gallery-controls-section">
        <span className="gallery-kicker">APPEARANCE</span>
        <h2>Make it yours.</h2>
        <p>Theme variables are applied without changing the component code.</p>
        <div className="gallery-swatches" role="group" aria-label="Theme">
          {(['forest', 'ocean', 'violet'] as const).map(option => (
            <button key={option} type="button"
              className={`swatch swatch-${option} ${theme === option ? 'selected' : ''}`}
              aria-label={`${option} theme`} aria-pressed={theme === option}
              onClick={() => onThemeChange(option)} />
          ))}
        </div>
      </div>
      {view === 'login' && <div className="gallery-controls-section">
        <span className="gallery-kicker">SIGN-IN METHODS</span>
        <label className="gallery-toggle">
          <span>OAuth providers</span>
          <input type="checkbox" checked={showProviders} disabled={connection.providers.length === 0}
            onChange={event => onProvidersChange(event.target.checked)} />
        </label>
        <label className="gallery-toggle">
          <span>Passkeys</span>
          <input type="checkbox" checked={showPasskeys} disabled={!connection.passkeys}
            onChange={event => onPasskeysChange(event.target.checked)} />
        </label>
      </div>}
      <div className="gallery-controls-section">
        <span className="gallery-kicker">TRY IT</span>
        {connection.mode === 'live'
          ? <p>This preview uses your real Motherbase project. Sign-up, profile, and security actions persist there.</p>
          : view === 'login'
            ? <p>Use <code>demo@example.com</code> with any password. For MFA, use <code>mfa@example.com</code>, then <code>123456</code>.</p>
            : <p>Forms use a local mock. They never contact a Motherbase server or send an email.</p>}
      </div>
      <div className="gallery-controls-foot">
        <span>RENDERED COMPONENTS</span>
        <p>{views.find(item => item.id === view)?.components}</p>
      </div>
    </aside>
  );
}

export function Gallery({ connection = demoConnection }: { connection?: PreviewConnection }) {
  const [view, setView] = useState<View>('login');
  const [theme, setTheme] = useState<Theme>('forest');
  const [showProviders, setShowProviders] = useState(connection.providers.length > 0);
  const [showPasskeys, setShowPasskeys] = useState(connection.passkeys);
  const selected = views.find(item => item.id === view)!;

  return (
    <MotherbaseProvider client={connection.client} initialUser={connection.mode === 'demo' ? demoUser : undefined}>
      <div className={`gallery theme-${theme}`}>
        <Sidebar view={view} connection={connection} onViewChange={setView} />
        <main className="gallery-main">
          <header className="gallery-topbar">
            <span>COMPONENT LIBRARY <b>/</b> AUTH</span>
            <span className="gallery-version">@motherbase/ui · 0.2.0</span>
          </header>
          <div className="gallery-heading">
            <div>
              <span className="gallery-kicker">{selected.number} / LIVE PREVIEW</span>
              <h1>{selected.label}</h1>
              <p>{selected.description}</p>
            </div>
            <span className="gallery-live"><span className="gallery-status-dot" /> {connection.mode === 'live' ? 'Live instance' : 'Interactive preview'}</span>
          </div>
          <div className="gallery-workspace">
            <section className="gallery-preview" aria-label={`${selected.label} preview`}>
              <Preview view={view} connection={connection} showProviders={showProviders}
                showPasskeys={showPasskeys} onViewChange={setView} />
            </section>
            <Controls view={view} theme={theme} connection={connection} showProviders={showProviders} showPasskeys={showPasskeys}
              onThemeChange={setTheme} onProvidersChange={setShowProviders} onPasskeysChange={setShowPasskeys} />
          </div>
          <footer className="gallery-footer">
            <span>Motherbase UI playground</span>
            <span>Built for React &amp; Next.js</span>
          </footer>
        </main>
      </div>
    </MotherbaseProvider>
  );
}
