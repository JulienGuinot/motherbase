import { describe, it, expectTypeOf } from 'vitest';
import { createClient } from '../src/index.js';

// `client.auth` is Better Auth's client typed with the plugins the server
// mounts. This file fails to compile when one of them drops out of
// `AuthPlugins` in src/auth.ts, which is what "every Better Auth method is
// there" rests on.

describe('client.auth exposes Better Auth', () => {
  const { auth } = createClient('http://localhost:3000');

  it('has the core endpoints, sessions included', () => {
    expectTypeOf(auth.signIn.email).toBeFunction();
    expectTypeOf(auth.signUp.email).toBeFunction();
    expectTypeOf(auth.listSessions).toBeFunction();
    // A call, not `toBeCallableWith`: Better Auth's methods are generic, which
    // expectTypeOf cannot instantiate. This file is type-checked, never run.
    void auth.revokeSession({ token: 'session-token' });
    // @ts-expect-error the session to revoke is required
    void auth.revokeSession({});
    expectTypeOf(auth.revokeOtherSessions).toBeFunction();
    expectTypeOf(auth.changePassword).toBeFunction();
  });

  it('has every mounted plugin', () => {
    expectTypeOf(auth.signIn.anonymous).toBeFunction();
    expectTypeOf(auth.emailOtp.sendVerificationOtp).toBeFunction();
    expectTypeOf(auth.signIn.magicLink).toBeFunction();
    expectTypeOf(auth.phoneNumber.sendOtp).toBeFunction();
    expectTypeOf(auth.twoFactor.enable).toBeFunction();
    expectTypeOf(auth.organization.create).toBeFunction();
    expectTypeOf(auth.organization.createTeam).toBeFunction();
    expectTypeOf(auth.signIn.oauth2).toBeFunction();
    expectTypeOf(auth.token).toBeFunction();
    expectTypeOf(auth.signIn.passkey).toBeFunction();
    expectTypeOf(auth.passkey.addPasskey).toBeFunction();
    expectTypeOf(auth.signIn.sso).toBeFunction();
    expectTypeOf(auth.apiKey.create).toBeFunction();
  });

  // Without `inferAdditionalFields`, Better Auth's client only knows `name` and
  // `image`, and the profile fields the server accepts were a compile error.
  it('types the Motherbase user fields on updateUser', () => {
    void auth.updateUser({ firstName: 'Ada', lastName: 'Lovelace', username: 'ada' });
    void auth.updateUser({ name: 'Ada', image: 'https://example.com/a.png' });
    // @ts-expect-error typed, not merely tolerated
    void auth.updateUser({ firstName: 42 });
    // @ts-expect-error server-set, not client-writable
    void auth.updateUser({ role: 'ADMIN' });
    // @ts-expect-error a removed column: the avatar is Better Auth's `image`
    void auth.updateUser({ imageUrl: 'https://example.com/a.png' });
  });

  it('has the Motherbase additions', () => {
    expectTypeOf(auth.onAuthStateChange).toBeFunction();
    expectTypeOf(auth.getSessionFromUrl).toBeFunction();
    expectTypeOf(auth.exchangeCodeForSession).toBeFunction();
    expectTypeOf(auth.updateUserCredentials).toBeFunction();
    expectTypeOf(auth.admin.listUsers).toBeFunction();
  });
});
