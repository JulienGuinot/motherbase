import { body } from 'express-validator';
import { z } from 'zod';

/**
 * Push tokens are long but bounded: FCM registration tokens are ~163 chars,
 * APNs ones 64. The column is unique and upserted on, so an unbounded token was
 * a way to write arbitrary bytes into the device table.
 */
export const PUSH_TOKEN_MAX = 4096;
/** FCM/APNs reject a payload over 4KB anyway; cap before the provider does. */
export const PUSH_TITLE_MAX = 200;
export const PUSH_BODY_MAX = 4000;
export const PUSH_DATA_KEYS_MAX = 25;
export const PUSH_DATA_VALUE_MAX = 1000;

const token = (field = 'token') =>
  body(field, 'token is missing').isString().isLength({ min: 1, max: PUSH_TOKEN_MAX });

export const registerDeviceValidator = [
  token(),
  body('platform', 'platform is missing').isIn(['ios', 'android', 'web']),
];

export const unregisterDeviceValidator = [token()];

/** The most users one `/api/notifications/send` call may target. */
export const PUSH_USERS_MAX = 1000;

const pushMessage = z.object({
  title: z.string().min(1).max(PUSH_TITLE_MAX),
  body: z.string().min(1).max(PUSH_BODY_MAX),
  // The provider's `data` map is flat string→string; anything else fails at
  // send time with an opaque provider error, so reject it here instead.
  data: z
    .record(z.string(), z.string().max(PUSH_DATA_VALUE_MAX))
    .refine(value => Object.keys(value).length <= PUSH_DATA_KEYS_MAX, `at most ${PUSH_DATA_KEYS_MAX} keys`)
    .optional(),
});

const userId = z.string().min(1).max(128);

/** One user (`userId`) or many (`userIds`), not both. */
export const sendNotificationSchema = pushMessage
  .extend({
    userId: userId.optional(),
    userIds: z.array(userId).min(1).max(PUSH_USERS_MAX).optional(),
  })
  .refine(value => (value.userId === undefined) !== (value.userIds === undefined), {
    message: 'give either userId or userIds',
  });

export const testNotificationSchema = pushMessage;
