import { createHmac, randomBytes } from 'crypto';
import { safeEqual } from './safe-equal';

/**
 * GitHub's `X-Hub-Signature-256`: `sha256=` + HMAC-SHA256 of the raw request
 * body under the webhook secret. Used by the project git webhook and by the
 * console's preview hook, which is why it lives here rather than in either.
 *
 * Returns false rather than throwing on a malformed or missing header: an
 * attacker probing the endpoint should see one uniform rejection, not a
 * difference between "wrong shape" and "wrong secret". The comparison is
 * constant-time (`safeEqual`).
 */
export function verifyHubSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
): boolean {
  if (!secret || !header?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(Buffer.from(rawBody as any)).digest('hex')}`;
  return safeEqual(header, expected);
}

/** A new outgoing-webhook secret: `whsec_` + base64 of 32 random bytes. */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

/**
 * The Standard Webhooks headers (https://www.standardwebhooks.com) for one
 * delivery, so a receiver can verify it with any of that spec's libraries:
 * `webhook-signature` is `v1,` + base64 HMAC-SHA256, keyed by the secret's
 * base64 part decoded, over `${id}.${timestamp}.${body}`. The id stays the same
 * across retries of a delivery, which is what a receiver deduplicates on; the
 * timestamp (seconds) is what it checks for replay.
 */
export function standardWebhookHeaders(
  secret: string,
  id: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${signature}`,
  };
}
