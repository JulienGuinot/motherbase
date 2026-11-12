/**
 * The `user.additionalFields` every Motherbase project's auth instance declares
 * (`apps/server/auth/instance.ts`), in Better Auth's own field syntax. Fed to
 * `inferAdditionalFields`, it is what lets `client.auth.updateUser({ firstName })`
 * and `signUp.email({ ..., lastName })` type-check, and puts the fields on the
 * session user.
 *
 * `input: true` fields are client-writable; the rest are server-set. The server
 * cannot import this package at runtime, so it keeps its own list (with the
 * validators and defaults) and `apps/server/tests/user-fields-contract.unit.test.ts`
 * fails when the two disagree.
 */
export const MOTHERBASE_USER_FIELDS = {
  username: { type: 'string', required: false, input: true },
  firstName: { type: 'string', required: false, input: true },
  lastName: { type: 'string', required: false, input: true },
  role: { type: 'string', required: false, input: false },
  isAnonymous: { type: 'boolean', required: false, input: false },
  status: { type: 'string', required: false, input: false },
} as const;
