import { z } from 'zod';

/**
 * The only shape a client may write into a user profile, shared by every path
 * that accepts one: the REST controller (`PUT /api/users/username`) and Better
 * Auth's `additionalFields` validators, which cover sign-up and
 * `POST /api/auth/update-user`.
 *
 * Before this, only the REST route checked anything, so a client could send a
 * 500-character username straight through Better Auth's update-user.
 */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;
export const PERSON_NAME_MAX = 80;
export const URL_MAX = 2048;

export const usernameSchema = z
  .string()
  .trim()
  .min(USERNAME_MIN, `username must be at least ${USERNAME_MIN} characters`)
  .max(USERNAME_MAX, `username must be at most ${USERNAME_MAX} characters`)
  .regex(/^[A-Za-z0-9._-]+$/, 'username may only contain letters, digits, dot, underscore and hyphen');

export const personNameSchema = z
  .string()
  .trim()
  .max(PERSON_NAME_MAX, `must be at most ${PERSON_NAME_MAX} characters`)
  // Control characters render as nothing, which is how a display name hides
  // what it really says.
  .refine(value => !/\p{Cc}/u.test(value), 'must not contain control characters');

/**
 * Better Auth's own `name` / `image` columns. They are not additionalFields, so
 * no validator can be attached to them, and they also arrive from OAuth
 * providers, where rejecting a long value would break the sign-in rather than
 * the abuse. Cap instead of reject, and drop an image URL that is not http(s).
 *
 * Returns only the keys it changed, or null when there was nothing to change.
 */
export function capCoreProfileFields(user: Record<string, unknown>): Record<string, unknown> | null {
  const capped: Record<string, unknown> = {};
  if (typeof user.name === 'string') {
    const name = user.name.trim().slice(0, PERSON_NAME_MAX);
    if (name !== user.name) capped.name = name;
  }
  if (typeof user.image === 'string') {
    const image = user.image.trim();
    const usable = image.length <= URL_MAX && /^https?:\/\//i.test(image);
    if (!usable) capped.image = null;
    else if (image !== user.image) capped.image = image;
  }
  return Object.keys(capped).length > 0 ? capped : null;
}

type StructuredName = { firstName?: unknown; lastName?: unknown };

const namePart = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/**
 * What the `users_derive_name` trigger (migration 20261112090000) makes of
 * `name`: "firstName lastName" when either is set, otherwise null (the written
 * `name` is kept). Must stay in step with that SQL.
 */
export function derivedName({ firstName, lastName }: StructuredName): string | null {
  return [namePart(firstName), namePart(lastName)].filter(Boolean).join(' ') || null;
}

/**
 * True when an update sets a `name` the trigger is about to overwrite, because
 * the row (after this update) still has a first or last name. Rejecting it
 * beats answering 200 for a name that was never stored.
 */
export function discardsWrittenName(update: Record<string, unknown>, current: StructuredName): boolean {
  if (typeof update.name !== 'string') return false;
  const derived = derivedName({
    firstName: 'firstName' in update ? update.firstName : current.firstName,
    lastName: 'lastName' in update ? update.lastName : current.lastName,
  });
  return derived !== null && derived !== update.name.trim();
}
