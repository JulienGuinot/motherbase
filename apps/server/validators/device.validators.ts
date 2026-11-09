import { body } from 'express-validator';

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

/** The provider's `data` map is flat string→string; anything else fails at send
 *  time with an opaque provider error, so reject it here instead. */
const pushData = body('data')
  .optional()
  .custom(value => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('data must be an object');
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > PUSH_DATA_KEYS_MAX) throw new Error(`data must have at most ${PUSH_DATA_KEYS_MAX} keys`);
    for (const [key, item] of entries) {
      if (typeof item !== 'string') throw new Error(`data.${key} must be a string`);
      if (item.length > PUSH_DATA_VALUE_MAX) throw new Error(`data.${key} is too long`);
    }
    return true;
  });

const message = [
  body('title', 'title is missing').isString().isLength({ min: 1, max: PUSH_TITLE_MAX }),
  body('body', 'body is missing').isString().isLength({ min: 1, max: PUSH_BODY_MAX }),
  pushData,
];

export const registerDeviceValidator = [
  token(),
  body('platform', 'platform is missing').isIn(['ios', 'android', 'web']),
];

export const unregisterDeviceValidator = [token()];

export const sendNotificationValidator = [
  body('userId', 'userId is missing').isString().isLength({ min: 1, max: 128 }),
  ...message,
];

export const testNotificationValidator = message;
