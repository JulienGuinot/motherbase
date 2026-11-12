import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createClient, memoryStorage } from '@motherbase/client';
import { MfaSettings, SignOutButton, AuthCallback, AuthLoading, SignedIn, SignedOut, LoginForm, MotherbaseProvider, SignUpForm, UserAvatar, UserButton, avatarSrc } from '../src/index.js';

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

const user = { id: 'u1', email: 'ada@example.com', name: 'Ada' };

function clientWithRoutes(routes: Record<string, (init: RequestInit) => { body: unknown; status?: number }>) {
  const fetchSpy = vi.fn(async (url: string, init: RequestInit = {}) => {
    const route = routes[new URL(url).pathname];
    if (!route) throw new Error(`Unexpected request: ${url}`);
    const result = route(init);
    return new Response(JSON.stringify(result.body), { status: result.status ?? 200 });
  });
  const client = createClient('https://api.example.com', undefined, {
    storage: memoryStorage(),
    fetch: fetchSpy as unknown as typeof fetch,
  });
  return { client, fetchSpy };
}

function fillCredentials() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: user.email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginForm', () => {
  it('shows the second factor only when the server asks for it', async () => {
    const onSuccess = vi.fn();
    const { client, fetchSpy } = clientWithRoutes({
      '/api/auth/sign-in/email': () => ({ body: { twoFactorRedirect: true, twoFactorMethods: ['totp'] } }),
      '/api/auth/two-factor/verify-totp': () => ({ body: { token: 'verified-token', user } }),
    });
    render(<LoginForm client={client} onSuccess={onSuccess} />);
    fillCredentials();

    expect(await screen.findByText('Verify your identity')).toBeTruthy();
    expect(onSuccess).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'verified-token' })));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('signs in directly when the server returns a session', async () => {
    const onSuccess = vi.fn();
    const { client } = clientWithRoutes({
      '/api/auth/sign-in/email': () => ({ body: { token: 'password-token', user } }),
    });
    render(<LoginForm client={client} onSuccess={onSuccess} />);
    fillCredentials();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'password-token' })));
    expect(screen.queryByText('Verify your identity')).toBeNull();
  });

  it('replaces every label, including the second factor and provider buttons', async () => {
    const { client } = clientWithRoutes({
      '/api/auth/sign-in/email': () => ({ body: { twoFactorRedirect: true, twoFactorMethods: ['totp'] } }),
    });
    render(<LoginForm client={client} providers={['github']} labels={{
      email: 'E-mail', password: 'Mot de passe', submit: 'Se connecter',
      continueWith: provider => `Continuer avec ${provider}`,
      mfa: { title: 'Vérifiez votre identité' },
    }} />);

    expect(screen.getByRole('button', { name: 'Continuer avec Github' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: user.email } });
    fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(await screen.findByRole('heading', { name: 'Vérifiez votre identité' })).toBeTruthy();
    // Labels left out keep their default.
    expect(screen.getByRole('button', { name: 'Verify and sign in' })).toBeTruthy();
  });
});

describe('SignUpForm', () => {
  it('prompts for email verification without claiming the user is signed in', async () => {
    const onSuccess = vi.fn();
    const { client } = clientWithRoutes({
      '/api/auth/sign-up/email': () => ({ body: { token: null, user } }),
    });
    render(<SignUpForm client={client} onSuccess={onSuccess} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: user.email } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Check your email to finish creating your account.')).toBeTruthy();
    expect(onSuccess).toHaveBeenCalledWith(null);
  });
});

describe('UserButton', () => {
  it('shows the user and signs out through the shared client', async () => {
    const { client } = clientWithRoutes({
      '/api/auth/sign-in/email': () => ({ body: { token: 'password-token', user } }),
      '/api/auth/sign-out': () => ({ body: { success: true } }),
    });
    await client.auth.signIn.email({ email: user.email, password: 'password' });
    render(<MotherbaseProvider client={client}><UserButton profileHref="/profile" /></MotherbaseProvider>);

    fireEvent.click(await screen.findByText('Ada'));
    expect(screen.getByRole('link', { name: 'Profile' }).getAttribute('href')).toBe('/profile');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.queryByText('Ada')).toBeNull());
  });
});

describe('UserAvatar', () => {
  it('prefers the user image, then falls back to a custom node or the blobatar', () => {
    const { container } = render(<UserAvatar user={{ name: 'Ada', image: 'https://cdn.example.com/ada.png' }} />);
    const image = container.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('https://cdn.example.com/ada.png');

    fireEvent.error(image);
    expect(container.querySelector('img')!.getAttribute('src')).not.toBe('https://cdn.example.com/ada.png');
    cleanup();

    render(<UserAvatar user={{ name: 'Ada', image: 'https://cdn.example.com/ada.png' }} src={null} fallback={name => <b>{name[0]}</b>} />);
    expect(screen.getByText('A')).toBeTruthy();
  });

  it('reads the image from user_metadata too', () => {
    expect(avatarSrc({ user_metadata: { image: 'a' } })).toBe('a');
    expect(avatarSrc({ name: 'Ada' })).toBeUndefined();
  });
});

describe('auth gates', () => {
  it('switch on the session and stay empty while it loads', async () => {
    const { client } = clientWithRoutes({
      '/api/auth/sign-in/email': () => ({ body: { token: 'password-token', user } }),
    });
    render(<MotherbaseProvider client={client}>
      <AuthLoading>loading</AuthLoading><SignedIn>in</SignedIn><SignedOut>out</SignedOut>
    </MotherbaseProvider>);
    expect(screen.queryByText('in')).toBeNull();
    expect(screen.queryByText('out')).toBeNull();

    expect(await screen.findByText('out')).toBeTruthy();
    expect(screen.queryByText('loading')).toBeNull();
    await client.auth.signIn.email({ email: user.email, password: 'password' });
    expect(await screen.findByText('in')).toBeTruthy();
    expect(screen.queryByText('out')).toBeNull();
  });
});

describe('AuthCallback', () => {
  it('consumes an OAuth token once under React Strict Mode', async () => {
    window.history.replaceState({}, '', '/callback#access_token=oauth-token');
    const onSuccess = vi.fn();
    const { client, fetchSpy } = clientWithRoutes({
      '/api/auth/get-session': () => ({ body: { session: { token: 'oauth-token' }, user } }),
    });

    render(<StrictMode><AuthCallback client={client} onSuccess={onSuccess} /></StrictMode>);

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('');
  });
});

describe('auth UI failures and repeated enrollment', () => {
  it.each(['button', 'menu'])('shows a failed sign-out and does not call onSignOut (%s)', async kind => {
    const { client } = clientWithRoutes({
      '/api/auth/sign-in/email': () => ({ body: { token: 'token', user } }),
      '/api/auth/sign-out': () => ({ body: { message: 'Cannot sign out' }, status: 500 }),
    });
    await client.auth.signIn.email({ email: user.email, password: 'password' });
    const onSignOut = vi.fn();
    render(<MotherbaseProvider client={client}>{kind === 'button'
      ? <SignOutButton onSignOut={onSignOut} /> : <UserButton onSignOut={onSignOut} />}</MotherbaseProvider>);
    if (kind === 'menu') fireEvent.click(await screen.findByText('Ada'));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Cannot sign out');
    expect(onSignOut).not.toHaveBeenCalled();
    expect((await client.hydrate())?.accessToken).toBe('token');
  });

  it('requires a new code when MFA is enabled again in the same component', async () => {
    let enabled = false;
    let enrollments = 0;
    const { client } = clientWithRoutes({
      '/api/auth/get-session': () => ({ body: { session: { token: 'token' }, user: { ...user, twoFactorEnabled: enabled } } }),
      '/api/auth/two-factor/enable': () => {
        enrollments++;
        return { body: { totpURI: `otpauth://totp/test?secret=SECRET${enrollments}`, backupCodes: ['recovery'] } };
      },
      '/api/auth/two-factor/verify-totp': () => { enabled = true; return { body: { status: true } }; },
      '/api/auth/two-factor/disable': () => { enabled = false; return { body: { status: true } }; },
    });
    render(<MfaSettings client={client} renderQr={uri => <span>{uri}</span>} />);
    fireEvent.submit((await screen.findByText('Set up two-factor authentication')).closest('form')!);
    fireEvent.submit((await screen.findByText('Verify authenticator')).closest('form')!);
    fireEvent.click(await screen.findByText("I've saved the codes"));
    fireEvent.submit((await screen.findByText('Turn off two-factor authentication')).closest('form')!);
    fireEvent.submit((await screen.findByText('Set up two-factor authentication')).closest('form')!);
    expect(await screen.findByText('Verify authenticator')).toBeTruthy();
    expect(screen.queryByText("I've saved the codes")).toBeNull();
    expect(screen.getByText('SECRET2')).toBeTruthy();
    expect((screen.getByLabelText('Verification code') as HTMLInputElement).value).toBe('');
  });
});
