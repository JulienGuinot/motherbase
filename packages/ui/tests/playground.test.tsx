import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createClient, memoryStorage } from '@motherbase/client';
import { readLiveConfiguration } from '../playground/config.js';
import { Gallery } from '../playground/gallery.js';

afterEach(cleanup);

it('previews the main component groups and sign-in options', async () => {
  render(<Gallery />);

  expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy();
  fireEvent.click(screen.getByLabelText('OAuth providers'));
  expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Security' }));
  expect(await screen.findByRole('heading', { name: 'Passkeys' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Two-factor authentication' })).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Recovery' }));
  expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeTruthy();
});

it('runs the mocked second-factor sign-in flow', async () => {
  render(<Gallery />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'mfa@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } });
  fireEvent.click(within(screen.getByRole('region', { name: 'Sign in preview' })).getByRole('button', { name: 'Sign in' }));

  expect(await screen.findByRole('heading', { name: 'Verify your identity' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));

  expect(await screen.findByRole('heading', { name: 'Signed in' })).toBeTruthy();
});

it('requires a complete public configuration for live mode', () => {
  expect(readLiveConfiguration({}).config).toBeNull();
  expect(readLiveConfiguration({ VITE_MOTHERBASE_URL: 'https://api.example.com' }).error).toMatch(/both/);
  expect(readLiveConfiguration({ VITE_MOTHERBASE_URL: 'https://api.example.com', VITE_MOTHERBASE_KEY: 'mb_secret_test' }).error).toMatch(/publishable/);
  expect(readLiveConfiguration({
    VITE_MOTHERBASE_URL: 'https://api.example.com',
    VITE_MOTHERBASE_KEY: 'mb_publishable_test',
    VITE_MOTHERBASE_PROVIDERS: 'google, github',
    VITE_MOTHERBASE_PASSKEYS: 'true',
  }).config).toMatchObject({ providers: ['google', 'github'], passkeys: true });
});

it('uses the connected client and unlocks the account after live sign-in', async () => {
  const fetchSpy = vi.fn(async () => Response.json({
    token: 'live-token',
    user: { id: 'live-user', email: 'live@example.com', name: 'Live User' },
  }));
  const client = createClient('https://api.example.com', 'mb_publishable_test', {
    storage: memoryStorage(),
    fetch: fetchSpy,
    autoRefresh: false,
  });
  render(<Gallery connection={{
    mode: 'live', client, authClient: client, providers: [], passkeys: false,
    url: 'https://api.example.com',
  }} />);

  fireEvent.click(screen.getByRole('button', { name: 'Account' }));
  expect(await screen.findByRole('heading', { name: 'Sign in to continue' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Go to sign in' }));
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'live@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } });
  fireEvent.click(within(screen.getByRole('region', { name: 'Sign in preview' })).getByRole('button', { name: 'Sign in' }));

  expect(await screen.findByRole('heading', { name: 'Profile' })).toBeTruthy();
  expect(fetchSpy).toHaveBeenCalledOnce();
});
