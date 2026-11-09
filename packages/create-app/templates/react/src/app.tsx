import type { ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router';
import {
  AuthCallback,
  ForgotPasswordForm,
  LoginPage,
  ResetPasswordForm,
  SecurityPanel,
  SignUpForm,
  UserButton,
  UserProfileForm,
  useAuth,
  useUser,
} from '@motherbase/ui';
import { authOptions } from './config/auth';

function Home() {
  return (
    <main className="hero">
      <div className="hero-copy">
        <span className="eyebrow">MOTHERBASE / STARTER</span>
        <h1>Your app starts here.</h1>
        <p>Authentication, account settings and a protected workspace are already wired up. Build your product on top.</p>
        <div className="hero-actions">
          <Link className="app-button" to="/signup">Create an account</Link>
          <Link className="app-link" to="/login">Sign in →</Link>
        </div>
      </div>
      <div className="hero-art" aria-hidden="true">
        <span className="hero-orbit" />
        <span className="hero-core">M</span>
        <span className="hero-caption">READY TO BUILD</span>
      </div>
    </main>
  );
}

function AuthPage({ children }: { children: ReactNode }) {
  return (
    <main className="auth-page">
      <Link className="brand" to="/">MOTHERBASE <span>STARTER</span></Link>
      {children}
    </main>
  );
}

function Login() {
  const navigate = useNavigate();
  return (
    <LoginPage
      providers={authOptions.providers}
      passkeys={authOptions.passkeys}
      oauthRedirectTo={`${window.location.origin}/auth/callback`}
      onSuccess={() => navigate('/app', { replace: true })}
      slots={{
        logo: <Link className="brand" to="/">MOTHERBASE <span>STARTER</span></Link>,
        footer: <p>New here? <Link to="/signup">Create an account</Link> · <Link to="/forgot-password">Forgot password?</Link></p>,
      }}
      aside={<div className="auth-aside"><span className="eyebrow">YOUR SPACE</span><h2>Pick up where you left off.</h2><p>Your project, your data, your next big idea.</p></div>}
    />
  );
}

function SignUp() {
  const navigate = useNavigate();
  return (
    <AuthPage>
      <SignUpForm onSuccess={session => { if (session) navigate('/app', { replace: true }); }} />
      <p className="auth-note">Already have an account? <Link to="/login">Sign in</Link></p>
    </AuthPage>
  );
}

function Callback() {
  const navigate = useNavigate();
  return <AuthPage><AuthCallback onSuccess={() => navigate('/app', { replace: true })} /></AuthPage>;
}

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <main className="setup" role="status">Checking your session…</main>;
  return user ? children : <Navigate to="/login" replace />;
}

function Workspace({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <main className="workspace">
      <header className="workspace-header">
        <Link className="brand" to="/app">MOTHERBASE <span>STARTER</span></Link>
        <UserButton
          profileHref="/app/account"
          securityHref="/app/account"
          onSignOut={() => navigate('/login', { replace: true })}
        />
      </header>
      <section className="workspace-content">{children}</section>
    </main>
  );
}

function Dashboard() {
  const user = useUser();
  return (
    <Workspace>
      <span className="eyebrow">YOUR WORKSPACE</span>
      <h1>Welcome{user?.name ? `, ${user.name}` : ''}.</h1>
      <p>Authentication is ready. Replace this space with the product you want to build.</p>
      <div className="starter-grid">
        <Link to="/app/account" className="starter-card">
          <span>01 / ACCOUNT</span>
          <strong>Profile & security</strong>
          <p>Edit your profile, add passkeys and manage MFA.</p>
          <b>Open settings →</b>
        </Link>
        <div className="starter-card">
          <span>02 / NEXT STEP</span>
          <strong>Make it yours</strong>
          <p>Use the Motherbase client to add data, storage, functions and realtime features.</p>
        </div>
      </div>
    </Workspace>
  );
}

function SecuritySettings() {
  if (authOptions.passkeys || authOptions.mfa) {
    return <SecurityPanel passkeys={authOptions.passkeys} mfa={authOptions.mfa} />;
  }
  return (
    <div className="starter-card">
      <span>SECURITY</span>
      <strong>More ways to sign in</strong>
      <p>Enable passkeys or MFA in Motherbase, then turn them on in <code>src/config/auth.ts</code>.</p>
    </div>
  );
}

function Account() {
  return (
    <Workspace>
      <Link className="app-link" to="/app">← Workspace</Link>
      <span className="eyebrow">ACCOUNT</span>
      <h1>Your account.</h1>
      <div className="settings-grid"><UserProfileForm /><SecuritySettings /></div>
    </Workspace>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/forgot-password" element={<AuthPage><ForgotPasswordForm /><p className="auth-note"><Link to="/login">Back to sign in</Link> · <Link to="/reset-password">Have a reset code?</Link></p></AuthPage>} />
      <Route path="/reset-password" element={<AuthPage><ResetPasswordForm /><p className="auth-note"><Link to="/login">Back to sign in</Link></p></AuthPage>} />
      <Route path="/auth/callback" element={<Callback />} />
      <Route path="/app" element={<Protected><Dashboard /></Protected>} />
      <Route path="/app/account" element={<Protected><Account /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
