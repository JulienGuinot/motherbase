import { body } from 'express-validator';
import { usernameSchema } from './user-fields';

// Delegates to the same schema Better Auth enforces on the `username`
// additionalField, so the two write paths cannot drift apart.
export const updateUsernameValidator = [
  body('username').trim().custom(value => {
    const parsed = usernameSchema.safeParse(value);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'username is not valid');
    return true;
  }),
];
