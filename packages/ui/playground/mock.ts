import { createClient, memoryStorage } from '@motherbase/client';
import type { Passkey, Session, User } from '@motherbase/client';

export const demoUser: User = {
  id: 'demo-user',
  email: 'demo@example.com',
  name: 'Alex Morgan',
  twoFactorEnabled: false,
};

const demoUrl = 'https://motherbase-demo.invalid';

function requestPath(input: RequestInfo | URL): string {
  return new URL(input instanceof Request ? input.url : String(input)).pathname;
}

function requestBody(init?: RequestInit): Record<string, string> {
  try {
    return JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
  } catch {
    return {};
  }
}

function unsupported(): Response {
  return Response.json({ message: 'This action needs a real Motherbase project.' }, { status: 400 });
}

async function guestFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = requestPath(input);
  const body = requestBody(init);
  if (path === '/api/auth/sign-in/email') {
    return Response.json(body.email === 'mfa@example.com'
      ? { twoFactorRedirect: true, twoFactorMethods: ['totp'] }
      : { token: 'demo-token', user: demoUser });
  }
  if (path === '/api/auth/two-factor/verify-totp' || path === '/api/auth/two-factor/verify-backup-code') {
    return body.code === '123456'
      ? Response.json({ token: 'demo-mfa-token', user: demoUser })
      : Response.json({ message: 'Use 123456 in this preview.' }, { status: 400 });
  }
  if (path === '/api/auth/sign-up/email') return Response.json({ token: null, user: { ...demoUser, email: body.email } });
  if (path === '/api/auth/email-otp/request-password-reset' || path === '/api/auth/email-otp/reset-password') {
    return Response.json({ success: true });
  }
  return unsupported();
}

let accountUser: User = { ...demoUser };
let accountSession: Session | null = { accessToken: 'demo-account-token', user: accountUser };
let passkeys: Passkey[] = [{
  id: 'demo-passkey',
  name: 'MacBook Pro',
  userId: demoUser.id,
  credentialID: 'demo-credential',
  publicKey: 'demo-public-key',
  counter: 0,
  deviceType: 'multiDevice',
  backedUp: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
}];

async function accountFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = requestPath(input);
  const body = requestBody(init);
  if (path === '/api/auth/get-session') return Response.json({ session: { token: 'demo-account-token' }, user: accountUser });
  if (path === '/api/auth/update-user') {
    accountUser = { ...accountUser, name: body.name };
    return Response.json({ user: accountUser });
  }
  if (path === '/api/auth/sign-out') return Response.json({ success: true });
  if (path === '/api/auth/passkey/list-user-passkeys') return Response.json(passkeys);
  if (path === '/api/auth/passkey/delete-passkey') {
    passkeys = passkeys.filter(passkey => passkey.id !== body.id);
    return Response.json({ status: true });
  }
  if (path === '/api/auth/two-factor/enable') {
    return Response.json({
      totpURI: 'otpauth://totp/Motherbase:demo@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Motherbase',
      backupCodes: ['alpha-111', 'beta-222', 'gamma-333'],
    });
  }
  if (path === '/api/auth/two-factor/verify-totp') {
    if (body.code !== '123456') return Response.json({ message: 'Use 123456 in this preview.' }, { status: 400 });
    accountUser = { ...accountUser, twoFactorEnabled: true };
    return Response.json({ token: 'demo-account-token', user: accountUser });
  }
  if (path === '/api/auth/two-factor/disable') {
    accountUser = { ...accountUser, twoFactorEnabled: false };
    return Response.json({ success: true });
  }
  return unsupported();
}

export const guestClient = createClient(demoUrl, undefined, {
  storage: memoryStorage(),
  fetch: guestFetch,
  autoRefresh: false,
});

export const accountClient = createClient(demoUrl, undefined, {
  storage: { get: () => accountSession, set: session => { accountSession = session; } },
  fetch: accountFetch,
  autoRefresh: false,
});
