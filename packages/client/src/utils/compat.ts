/**
 * supabase-js shape normalisation.
 *
 * Motherbase speaks Better Auth, which names things `accessToken`, `createdAt`
 * and puts custom profile fields flat on the user. supabase-js hands
 * applications `access_token`, `created_at` and `user_metadata`. Code ported
 * from Supabase reads the second set, and reading a field that does not exist
 * is not an error: it is `undefined`, rendered as a blank name or an infinite
 * loading spinner, at runtime, in production.
 *
 * So every session and user that leaves the SDK carries BOTH spellings. The
 * camelCase ones stay authoritative (nothing existing breaks); the snake_case
 * ones are aliases added on the way out. Normalisation happens in exactly one
 * place, the session store, so no call path can forget it.
 */
import type { Session, User, UserMetadata } from '../auth/types.js';

/** Fields Better Auth owns on the user, which are not profile metadata. */
const RESERVED_USER_FIELDS = new Set([
  'id',
  'email',
  'emailVerified',
  'createdAt',
  'updatedAt',
  'role',
  'twoFactorEnabled',
  'isAnonymous',
  // aliases this module itself adds, so a re-normalisation is idempotent
  'aud',
  'created_at',
  'updated_at',
  'email_confirmed_at',
  'confirmed_at',
  'phone',
  'app_metadata',
  'user_metadata',
  'identities',
  'is_anonymous',
]);

function asIso(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return undefined;
}

/**
 * Add the supabase-js user aliases without dropping anything Better Auth sent.
 *
 * `user_metadata` collects the profile fields (`name`, `image`, and any
 * `additionalFields` the project configured), because that is where a Supabase
 * app looks for them. They stay flat on the user as well.
 *
 * `app_metadata` is deliberately `{}` rather than a guessed `{ provider:
 * 'email' }`: the client cannot know which provider issued the session, and a
 * wrong provider is worse than a missing one. Reading `.provider` off it yields
 * `undefined` instead of throwing, which is the failure mode that lets an app
 * boot.
 */
export function normalizeUser(user: User | null | undefined): User | null {
  if (!user) return null;

  const metadata: UserMetadata = { ...user.user_metadata };
  for (const [key, value] of Object.entries(user) as [string, unknown][]) {
    if (!RESERVED_USER_FIELDS.has(key)) metadata[key] = value;
  }

  const createdAt = asIso(user.createdAt) ?? asIso(user.created_at);
  const updatedAt = asIso(user.updatedAt) ?? asIso(user.updated_at);
  // Better Auth stores email verification as a boolean, not a timestamp. The
  // honest mapping is "verified at some point at or before the last update":
  // apps branch on truthiness of this field, not on its exact value.
  const emailConfirmedAt = user.emailVerified ? (updatedAt ?? createdAt ?? null) : null;

  return {
    ...user,
    aud: user.aud ?? 'authenticated',
    role: user.role ?? 'authenticated',
    created_at: createdAt ?? null,
    updated_at: updatedAt ?? null,
    email_confirmed_at: emailConfirmedAt,
    confirmed_at: emailConfirmedAt,
    phone: user.phone ?? user.phoneNumber ?? '',
    app_metadata: user.app_metadata ?? {},
    user_metadata: metadata,
    identities: user.identities ?? [],
    // Better Auth's anonymous plugin names it `isAnonymous`.
    is_anonymous: user.is_anonymous ?? Boolean(user.isAnonymous),
  };
}

/**
 * Add the supabase-js session aliases.
 *
 * `expires_at` / `expires_in` are only emitted when the server actually told us
 * when the session ends. Inventing a lifetime would be worse than omitting it:
 * supabase-js callers use `expires_at` to decide when to refresh, and a made-up
 * value schedules a refresh at the wrong time.
 */
export function normalizeSession(session: Session | null | undefined): Session | null {
  if (!session) return null;
  const user = normalizeUser(session.user);
  const expiresAt = typeof session.expires_at === 'number' ? session.expires_at : undefined;

  return {
    ...session,
    user: user ?? session.user,
    access_token: session.accessToken,
    refresh_token: session.refreshToken ?? null,
    token_type: 'bearer',
    ...(expiresAt === undefined
      ? {}
      : { expires_at: expiresAt, expires_in: Math.max(0, expiresAt - Math.floor(Date.now() / 1000)) }),
  };
}
