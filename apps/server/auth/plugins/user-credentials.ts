import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, sendVerificationEmailFn, sessionMiddleware } from 'better-auth/api';
import { CREDENTIAL } from '../credentials';

/**
 * The two GoTrue endpoints Better Auth has no equivalent for, as one plugin.
 *
 *   POST /reauthenticate           GoTrue `GET /reauthenticate`: mail the
 *                                  signed-in user a one-time nonce.
 *   POST /update-user-credentials  GoTrue `PUT /user` for email and password:
 *                                  how `auth.updateUser({ email, password, nonce })`
 *                                  reaches the server.
 *
 * Better Auth's own routes cover the rest of `updateUser` (profile data through
 * `/update-user`, a password change with the current password through
 * `/change-password`). What they cannot do is the Supabase anonymous upgrade: a
 * guest has no email and no password, so neither `/change-email` (which needs a
 * verified address to confirm against) nor `/change-password` (which needs the
 * current one) applies. Upgrading in place matters because the guest's rows are
 * keyed on its id; signing up a fresh account would orphan them.
 */

/** Reauthentication nonces live this long, as GoTrue's do by default. */
export const REAUTH_NONCE_TTL_MS = 5 * 60 * 1000;

export interface UserCredentialsDeps {
  /** Mails the nonce to the signed-in user (same delivery as every email OTP). */
  sendNonce: (args: { email: string; nonce: string }) => Promise<void>;
}

const nonceIdentifier = (userId: string) => `reauthenticate:${userId}`;

/** Stored hashed, like Better Auth's own OTPs: a DB read must not yield a usable nonce. */
export function hashNonce(nonce: string): string {
  return createHash('sha256').update(nonce).digest('base64url');
}

export function nonceMatches(stored: string, candidate: string): boolean {
  const a = Buffer.from(stored);
  const b = Buffer.from(hashNonce(candidate));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function userCredentials(deps: UserCredentialsDeps) {
  return {
    id: 'user-credentials',
    endpoints: {
      reauthenticate: createAuthEndpoint(
        '/reauthenticate',
        { method: 'POST', use: [sessionMiddleware] },
        async ctx => {
          const { user } = ctx.context.session;
          if (!user.email || user.isAnonymous) {
            throw new APIError('BAD_REQUEST', { message: 'This user has no email address to send a nonce to.' });
          }
          const nonce = String(randomInt(0, 1_000_000)).padStart(6, '0');
          // One live nonce per user: asking again replaces the previous one.
          await ctx.context.internalAdapter.deleteVerificationByIdentifier(nonceIdentifier(user.id));
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: nonceIdentifier(user.id),
            value: hashNonce(nonce),
            expiresAt: new Date(Date.now() + REAUTH_NONCE_TTL_MS),
          });
          await deps.sendNonce({ email: user.email, nonce });
          return ctx.json({ success: true });
        },
      ),

      updateUserCredentials: createAuthEndpoint(
        '/update-user-credentials',
        {
          method: 'POST',
          use: [sessionMiddleware],
          body: z.object({
            email: z.string().email().optional(),
            password: z.string().optional(),
            nonce: z.string().optional(),
            /** Where the verification link lands, when verification is on. */
            callbackURL: z.string().optional(),
          }),
        },
        async ctx => {
          const { user } = ctx.context.session;
          const { email, password, nonce } = ctx.body;
          const adapter = ctx.context.internalAdapter;
          let updated: Record<string, unknown> = user;

          if (email !== undefined) {
            // A permanent account changes its address through Better Auth's
            // `/change-email`, which confirms against the old one. Only a guest,
            // who has nothing to confirm against, sets one here.
            if (!user.isAnonymous) {
              throw new APIError('BAD_REQUEST', { message: 'Only an anonymous user can set an email address this way.' });
            }
            const normalized = email.toLowerCase();
            if (await adapter.findUserByEmail(normalized)) {
              throw new APIError('UNPROCESSABLE_ENTITY', { message: 'A user with this email address has already been registered.' });
            }
            // Having an address to sign in with is what makes the guest permanent.
            updated = await adapter.updateUser(user.id, { email: normalized, emailVerified: false, isAnonymous: false });
            if (ctx.context.options.emailVerification?.sendVerificationEmail) {
              await sendVerificationEmailFn(ctx, updated as never);
            }
          }

          if (password !== undefined) {
            const { minPasswordLength, maxPasswordLength } = ctx.context.password.config;
            if (password.length < minPasswordLength || password.length > maxPasswordLength) {
              throw new APIError('BAD_REQUEST', {
                message: `Password must be between ${minPasswordLength} and ${maxPasswordLength} characters.`,
              });
            }
            if (updated.isAnonymous) {
              throw new APIError('BAD_REQUEST', { message: 'Set an email address before a password.' });
            }
            const accounts = await adapter.findAccounts(user.id);
            const credential = accounts.find(a => a.providerId === CREDENTIAL && a.password);
            const hash = await ctx.context.password.hash(password);
            if (!credential) {
              // First password on an account that signed in some other way
              // (a converted guest, a social login): nothing to prove.
              await adapter.linkAccount({ userId: user.id, providerId: CREDENTIAL, accountId: user.id, password: hash });
            } else {
              // Replacing one needs proof of presence: the nonce from
              // `/reauthenticate`. With the old password, `/change-password` applies.
              const stored = await adapter.findVerificationValue(nonceIdentifier(user.id));
              const valid = !!nonce && !!stored && stored.expiresAt > new Date() && nonceMatches(stored.value, nonce);
              if (!valid) {
                throw new APIError('UNAUTHORIZED', {
                  message: 'Reauthentication required: call reauthenticate() and pass the emailed nonce.',
                });
              }
              await adapter.deleteVerificationByIdentifier(nonceIdentifier(user.id));
              await adapter.updatePassword(user.id, hash);
            }
          }

          return ctx.json({ user: updated });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
